// A PDF with one JPEG per page, written by hand (no library). Messengers send a PDF as a document, unchanged,
// so the text on catalogue pages stays sharp.

export interface PdfPage {
  jpeg: Blob
  width: number // pixels of the JPEG
  height: number
}

/** `size` is the page size in points; the image fills the page. */
export async function jpegPdf(pages: PdfPage[], size = { w: 540, h: 960 }): Promise<Blob> {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (b: Uint8Array) => {
    parts.push(b)
    length += b.length
  }
  const write = (s: string) => push(enc.encode(s))
  const begin = (id: number) => {
    offsets[id] = length
    write(`${id} 0 obj\n`)
  }

  write('%PDF-1.4\n%âãÏÓ\n') // the second line marks the file as binary
  const pageId = (i: number) => 3 + i * 3
  begin(1)
  write('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  begin(2)
  write(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`)
  for (const [i, p] of pages.entries()) {
    const [page, content, image] = [pageId(i), pageId(i) + 1, pageId(i) + 2]
    begin(page)
    write(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.w} ${size.h}] /Resources << /XObject << /Im${i} ${image} 0 R >> >> /Contents ${content} 0 R >>\nendobj\n`,
    )
    const draw = `q ${size.w} 0 0 ${size.h} 0 0 cm /Im${i} Do Q`
    begin(content)
    write(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream\nendobj\n`)
    const bytes = new Uint8Array(await p.jpeg.arrayBuffer())
    begin(image)
    write(
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`,
    )
    push(bytes)
    write('\nendstream\nendobj\n')
  }
  const count = 3 + pages.length * 3
  const xref = length
  write(`xref\n0 ${count}\n0000000000 65535 f \n`)
  for (let id = 1; id < count; id++) write(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)
  write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}
