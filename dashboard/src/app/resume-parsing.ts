// Extracts plain text from an uploaded resume file entirely client-side —
// the file's bytes never leave the browser; only the extracted text is
// later sent (by resume-upload.ts) to the local Django/Ollama server for
// structuring. PDF via pdfjs-dist, DOCX via mammoth — picked by file
// extension since that's simpler and more reliable than sniffing bytes for
// these two well-defined formats.
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';

// pdf.js parses on a background worker; without pointing it at a real
// script URL it falls back to a slower/deprecated inline mode with console
// warnings. The worker file is copied into public/ (see
// dashboard/public/pdf.worker.min.mjs) specifically so it ships as a
// static asset in the build and resolves relative to baseHref: "./" the
// same way every other asset does under chrome-extension://<id>/....
pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.mjs';

export class UnsupportedResumeFileError extends Error {}

export async function extractResumeText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();

  if (name.endsWith('.pdf')) {
    return extractPdfText(buffer);
  }
  if (name.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value.trim();
  }
  throw new UnsupportedResumeFileError('Please upload a .pdf or .docx file.');
}

async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
    pageTexts.push(pageText);
  }
  return pageTexts.join('\n\n').trim();
}
