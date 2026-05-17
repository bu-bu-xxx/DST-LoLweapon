import hashlib
import html
import json
import re
import shutil
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
DOCX_PATH = ROOT / "英雄联盟武器更新计划.docx"
PUBLIC_DATA = ROOT / "public" / "data"
IMAGE_DIR = PUBLIC_DATA / "images"

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
}


def text_of(node):
    parts = []
    for text in node.findall(".//w:t", NS):
        parts.append(text.text or "")
    return "".join(parts).strip()


def style_of(paragraph):
    style = paragraph.find("./w:pPr/w:pStyle", NS)
    return style.attrib.get(f"{{{NS['w']}}}val", "") if style is not None else ""


def outline_level(paragraph):
    level = paragraph.find("./w:pPr/w:outlineLvl", NS)
    if level is None:
        return None
    value = level.attrib.get(f"{{{NS['w']}}}val")
    return int(value) + 1 if value is not None and value.isdigit() else None


def infer_heading_level(paragraph, text):
    style = style_of(paragraph).lower()
    outline = outline_level(paragraph)
    if outline:
        return min(outline, 6)

    match = re.search(r"(heading|标题)\s*([1-6])", style)
    if match:
        return int(match.group(2))

    if text == DOCX_PATH.stem:
        return 1

    if re.match(r"^(前言|S\d+\s*[：:])", text):
        return 2

    if re.match(r"^【[^】]+】", text):
        return 3

    if (
        text.endswith(("：", ":"))
        and len(text) <= 40
        and not text.startswith(("*", "-", "·", "•"))
    ):
        return 3

    if re.match(r"^(第[一二三四五六七八九十\d]+[章节篇]|[一二三四五六七八九十]+[、.．]|\d+(\.\d+){0,3}\s+)", text):
        return min(text.count(".") + 1, 4)

    return None


def collect_relationships(zf):
    rels_path = "word/_rels/document.xml.rels"
    rels = {}
    if rels_path not in zf.namelist():
        return rels
    tree = ET.fromstring(zf.read(rels_path))
    for rel in tree:
        rid = rel.attrib.get("Id")
        target = rel.attrib.get("Target", "")
        if rid and target:
            rels[rid] = target
    return rels


def image_refs(paragraph):
    refs = []
    for blip in paragraph.findall(".//a:blip", NS):
        rid = blip.attrib.get(f"{{{NS['r']}}}embed") or blip.attrib.get(f"{{{NS['r']}}}link")
        if rid:
            refs.append(rid)
    return refs


def slug_for(text, fallback):
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]
    return f"{fallback}-{digest}"


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def build_html(chunks):
    pieces = []
    for chunk in chunks:
        level = max(2, min(len(chunk["title_path"]) + 1, 6))
        pieces.append(f'<section id="{chunk["chunk_id"]}" class="doc-section">')
        pieces.append(f"<h{level}>{html.escape(chunk['title'])}</h{level}>")
        if chunk["title_path"]:
            path = " / ".join(chunk["title_path"])
            pieces.append(f'<div class="section-path">{html.escape(path)}</div>')
        for para in chunk["paragraphs"]:
            pieces.append(f"<p>{html.escape(para)}</p>")
        for image in chunk["images"]:
            src = html.escape(image["src"])
            alt = html.escape(image.get("caption") or chunk["title"])
            pieces.append(f'<figure><img src="{src}" alt="{alt}"><figcaption>{alt}</figcaption></figure>')
        pieces.append("</section>")
    return "\n".join(pieces)


def main():
    if not DOCX_PATH.exists():
        raise SystemExit(f"Missing source docx: {DOCX_PATH}")

    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    if IMAGE_DIR.exists():
        shutil.rmtree(IMAGE_DIR)
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(DOCX_PATH) as zf:
        rels = collect_relationships(zf)
        document = ET.fromstring(zf.read("word/document.xml"))
        body = document.find("w:body", NS)

        image_map = {}
        for rid, target in rels.items():
            if not target.startswith("media/"):
                continue
            source = f"word/{target}"
            if source not in zf.namelist():
                continue
            ext = Path(target).suffix or ".png"
            name = f"image-{len(image_map) + 1:03d}{ext}"
            out = IMAGE_DIR / name
            out.write_bytes(zf.read(source))
            image_map[rid] = f"/data/images/{name}"

        chunks = []
        stack = []
        current = None
        pending_images = []

        def start_chunk(title, level):
            nonlocal current, stack, chunks, pending_images
            if current:
                chunks.append(current)
            while len(stack) >= level:
                stack.pop()
            stack.append(title)
            chunk_id = slug_for(" / ".join(stack), f"doc-sec-{len(chunks) + 1:03d}")
            current = {
                "chunk_id": chunk_id,
                "title": title,
                "title_path": stack[:],
                "paragraphs": [],
                "content": "",
                "images": pending_images,
                "source_doc": DOCX_PATH.name,
                "anchor": f"/#${chunk_id}".replace("#$", "#"),
            }
            pending_images = []

        def ensure_current():
            if current is None:
                start_chunk(DOCX_PATH.stem, 1)

        for paragraph in body.findall("w:p", NS):
            text = text_of(paragraph)
            para_images = [
                {"src": image_map[rid], "caption": text}
                for rid in image_refs(paragraph)
                if rid in image_map
            ]

            if not text and para_images:
                ensure_current()
                current["images"].extend(para_images)
                continue
            if not text:
                continue

            level = infer_heading_level(paragraph, text)
            if level and len(text) <= 120:
                if para_images:
                    pending_images.extend(para_images)
                start_chunk(text, level)
                continue

            ensure_current()
            if para_images:
                current["images"].extend(para_images)
            current["paragraphs"].append(text)

        if current:
            chunks.append(current)

    for chunk in chunks:
        chunk["content"] = "\n".join(chunk["paragraphs"])

    toc = []
    node_stack = []
    for chunk in chunks:
        item = {
            "title": chunk["title"],
            "anchor": chunk["anchor"],
            "chunk_id": chunk["chunk_id"],
            "children": [],
        }
        depth = max(1, len(chunk["title_path"]))
        while len(node_stack) >= depth:
            node_stack.pop()
        if node_stack:
            node_stack[-1]["children"].append(item)
        else:
            toc.append(item)
        node_stack.append(item)

    search_index = [
        {
            "chunk_id": chunk["chunk_id"],
            "title": chunk["title"],
            "title_path": chunk["title_path"],
            "content": chunk["content"],
            "anchor": chunk["anchor"],
            "source_doc": chunk["source_doc"],
            "images": chunk["images"],
        }
        for chunk in chunks
    ]

    write_json(PUBLIC_DATA / "chunks.json", chunks)
    write_json(PUBLIC_DATA / "toc.json", toc)
    write_json(PUBLIC_DATA / "search-index.json", search_index)
    (PUBLIC_DATA / "content.html").write_text(build_html(chunks), encoding="utf-8")

    print(f"Generated {len(chunks)} chunks and {len(image_map)} images in {PUBLIC_DATA}")


if __name__ == "__main__":
    main()
