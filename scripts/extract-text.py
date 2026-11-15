# Text extraction for task attachments (pdf / docx). Run with `python -I` so nothing from the
# attachment's folder is importable. Prints UTF-8 text to stdout; exit 2 = unsupported.
import sys, io, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
path = sys.argv[1]
ext = os.path.splitext(path)[1].lower()
LIMIT = 80_000
out = []
if ext == ".pdf":
    try:
        try:
            import pymupdf as fitz
        except ImportError:
            import fitz
        with fitz.open(path) as doc:
            for i, page in enumerate(doc):
                out.append(f"--- page {i + 1} ---\n" + page.get_text())
                if sum(len(x) for x in out) > LIMIT:
                    break
    except ImportError:
        from pypdf import PdfReader
        r = PdfReader(path)
        for i, page in enumerate(r.pages):
            out.append(f"--- page {i + 1} ---\n" + (page.extract_text() or ""))
            if sum(len(x) for x in out) > LIMIT:
                break
elif ext == ".docx":
    import docx
    d = docx.Document(path)
    for p in d.paragraphs:
        if p.text.strip():
            out.append(p.text)
    for t in d.tables:
        for row in t.rows:
            out.append(" | ".join(c.text.strip() for c in row.cells))
else:
    sys.exit(2)
print("\n".join(out)[:LIMIT])
