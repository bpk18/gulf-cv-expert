const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const zlib = require('zlib');

// Try to load optional dependencies
let pdfParse;
let mammoth;
try {
  pdfParse = require('pdf-parse');
  mammoth = require('mammoth');
} catch (e) {
  console.warn('Optional dependencies not installed. PDF/DOCX parsing may not work.');
}

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname)));

// Create directories
const uploadDir = path.join(__dirname, 'uploads');
const pdfDir = path.join(__dirname, 'generated-pdfs');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
if (!fs.existsSync(pdfDir)) {
  fs.mkdirSync(pdfDir, { recursive: true });
}

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const fileFilter = (req, file, cb) => {
  // Accept any uploaded file type and decide how much text can be extracted later.
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// =========================
// FILE PARSING FUNCTIONS
// =========================

const PDF_PARSE_VERSIONS = ['v2.0.550', 'v1.10.100', 'v1.10.88', 'v1.9.426'];

function decodePdfByteString(buffer) {
  if (!buffer || buffer.length === 0) {
    return '';
  }

  if (
    buffer.length >= 2
    && buffer[0] === 0xFE
    && buffer[1] === 0xFF
    && buffer.length % 2 === 0
  ) {
    let result = '';
    for (let index = 2; index < buffer.length; index += 2) {
      result += String.fromCharCode((buffer[index] << 8) | buffer[index + 1]);
    }
    return result;
  }

  return buffer.toString('latin1');
}

function decodePdfEscapedString(value) {
  let result = '';

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      result += character;
      continue;
    }

    const nextCharacter = value[index + 1];
    if (!nextCharacter) {
      break;
    }

    switch (nextCharacter) {
      case 'n':
        result += '\n';
        index += 1;
        break;
      case 'r':
        result += '\r';
        index += 1;
        break;
      case 't':
        result += '\t';
        index += 1;
        break;
      case 'b':
        result += '\b';
        index += 1;
        break;
      case 'f':
        result += '\f';
        index += 1;
        break;
      case '(':
      case ')':
      case '\\':
        result += nextCharacter;
        index += 1;
        break;
      case '\n':
        index += 1;
        break;
      case '\r':
        index += value[index + 2] === '\n' ? 2 : 1;
        break;
      default:
        if (/[0-7]/.test(nextCharacter)) {
          let octalValue = nextCharacter;
          let octalIndex = index + 2;

          while (
            octalIndex < value.length
            && octalValue.length < 3
            && /[0-7]/.test(value[octalIndex])
          ) {
            octalValue += value[octalIndex];
            octalIndex += 1;
          }

          result += String.fromCharCode(Number.parseInt(octalValue, 8));
          index = octalIndex - 1;
        } else {
          result += nextCharacter;
          index += 1;
        }
    }
  }

  return result;
}

function decodePdfToken(token) {
  if (!token) {
    return '';
  }

  if (token.startsWith('(') && token.endsWith(')')) {
    return decodePdfEscapedString(token.slice(1, -1));
  }

  if (token.startsWith('<') && token.endsWith('>')) {
    const hexValue = token
      .slice(1, -1)
      .replace(/[^0-9A-Fa-f]/g, '');

    if (!hexValue) {
      return '';
    }

    const paddedHexValue = hexValue.length % 2 === 0 ? hexValue : `${hexValue}0`;
    return decodePdfByteString(Buffer.from(paddedHexValue, 'hex'));
  }

  return '';
}

function extractPdfTextOperators(content) {
  const collected = [];
  const operatorPattern = /(\((?:\\.|[^\\()])*\)|<[\dA-Fa-f\s]+>)\s*Tj|\[((?:[\s\S]*?))\]\s*TJ|(\((?:\\.|[^\\()])*\))\s*['"]/g;

  let match;
  while ((match = operatorPattern.exec(content)) !== null) {
    if (match[1]) {
      const singleToken = safeText(decodePdfToken(match[1]));
      if (singleToken) {
        collected.push(singleToken);
      }
      continue;
    }

    if (match[2]) {
      const arrayTokens = match[2].match(/\((?:\\.|[^\\()])*\)|<[\dA-Fa-f\s]+>/g) || [];
      const arrayText = safeText(arrayTokens.map((token) => decodePdfToken(token)).join(' '));
      if (arrayText) {
        collected.push(arrayText);
      }
      continue;
    }

    if (match[3]) {
      const quotedToken = safeText(decodePdfToken(match[3]));
      if (quotedToken) {
        collected.push(quotedToken);
      }
    }
  }

  return safeText(collected.join('\n'));
}

function salvagePdfTextFromBuffer(fileBuffer) {
  const binaryContent = fileBuffer.toString('latin1');
  const streamPattern = /(<<[\s\S]*?>>)?\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const extractedChunks = [];
  let match;

  while ((match = streamPattern.exec(binaryContent)) !== null) {
    const dictionary = match[1] || '';
    const streamBuffer = Buffer.from(match[2], 'latin1');

    const candidates = [streamBuffer];
    if (/FlateDecode/.test(dictionary)) {
      try {
        candidates.unshift(zlib.inflateSync(streamBuffer));
      } catch (inflateError) {
        try {
          candidates.unshift(zlib.inflateRawSync(streamBuffer));
        } catch (inflateRawError) {
          // Ignore and keep the raw stream candidate below.
        }
      }
    }

    candidates.forEach((candidateBuffer) => {
      const extractedText = extractPdfTextOperators(candidateBuffer.toString('latin1'));
      if (extractedText) {
        extractedChunks.push(extractedText);
      }
    });
  }

  return safeText(extractedChunks.join('\n\n'));
}

async function parsePDFWithVersion(fileBuffer, version) {
  const PDFJS = require(`pdf-parse/lib/pdf.js/${version}/build/pdf.js`);
  PDFJS.disableWorker = true;

  const loadingTask = PDFJS.getDocument({
    data: new Uint8Array(fileBuffer),
    stopAtErrors: false,
    nativeImageDecoderSupport: 'none'
  });

  const pdfDocument = await (loadingTask.promise || loadingTask);
  const pageCount = pdfDocument.numPages || 0;
  const lines = [];

  for (let pageIndex = 1; pageIndex <= pageCount; pageIndex += 1) {
    try {
      const page = await pdfDocument.getPage(pageIndex);
      const textContent = await page.getTextContent({
        normalizeWhitespace: true,
        disableCombineTextItems: false
      });

      let lastY;
      let pageText = '';

      for (const item of textContent.items || []) {
        const itemText = safeText(item?.str);
        if (!itemText) {
          continue;
        }

        if (lastY === undefined || lastY === item.transform?.[5]) {
          pageText += itemText;
        } else {
          pageText += `\n${itemText}`;
        }

        lastY = item.transform?.[5];
      }

      if (safeText(pageText)) {
        lines.push(pageText);
      }
    } catch (pageError) {
      // Ignore individual page errors and continue with the remaining pages.
    }
  }

  if (typeof pdfDocument.destroy === 'function') {
    await pdfDocument.destroy();
  }

  return safeText(lines.join('\n\n'));
}

async function parsePDF(filePath) {
  if (!pdfParse) {
    throw new Error('PDF parsing not available. Run: npm install pdf-parse');
  }

  const fileBuffer = fs.readFileSync(filePath);
  const parsingErrors = [];

  try {
    const data = await pdfParse(fileBuffer);
    const parsedText = safeText(data?.text);
    if (parsedText) {
      return parsedText;
    }
  } catch (error) {
    parsingErrors.push(error.message);
  }

  for (const version of PDF_PARSE_VERSIONS) {
    try {
      const parsedText = await parsePDFWithVersion(fileBuffer, version);
      if (parsedText) {
        console.warn(`Recovered PDF text using pdf.js ${version}`);
        return parsedText;
      }
    } catch (error) {
      parsingErrors.push(`${version}: ${error.message}`);
    }
  }

  const salvagedText = salvagePdfTextFromBuffer(fileBuffer);
  if (salvagedText) {
    console.warn('Recovered PDF text using raw stream fallback');
    return salvagedText;
  }

  throw new Error(
    `Could not extract readable text from this PDF. ${
      parsingErrors[0] || 'The file may be scanned, damaged, or protected.'
    }`
  );
}

async function parseDOCX(filePath) {
  if (!mammoth) {
    throw new Error('DOCX parsing not available. Run: npm install mammoth');
  }
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

function parseTXT(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

const TEXT_LIKE_EXTENSIONS = new Set([
  '.txt', '.text', '.csv', '.tsv', '.md', '.markdown', '.rtf',
  '.html', '.htm', '.xml', '.svg', '.json', '.yaml', '.yml', '.ini',
  '.log', '.sql', '.js', '.ts', '.css'
]);

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.heic'
]);

function getFileExtension(fileName) {
  return path.extname(String(fileName || '').toLowerCase());
}

function normalizeExtractedText(text) {
  return safeText(String(text || '').replace(/`n/g, '\n'));
}

function stripHtmlTags(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripRtfMarkup(text) {
  return String(text || '')
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\tab/g, ' ')
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-z]+-?\d* ?/gi, ' ')
    .replace(/[{}]/g, ' ');
}

function looksLikeReadableText(text) {
  const value = normalizeExtractedText(text);
  if (value.length < 24) {
    return false;
  }

  const wordMatches = value.match(/[A-Za-z]{2,}/g) || [];
  return wordMatches.length >= 4;
}

function extractReadableTextFromBuffer(fileBuffer) {
  const candidates = [
    fileBuffer.toString('utf8'),
    fileBuffer.toString('utf16le'),
    fileBuffer.toString('latin1')
  ];

  for (const candidate of candidates) {
    if (looksLikeReadableText(candidate)) {
      return normalizeExtractedText(candidate);
    }
  }

  const latinText = fileBuffer.toString('latin1');
  const sequences = latinText.match(/[A-Za-z0-9@&()\/+.,:\- ]{4,}/g) || [];
  const collapsed = sequences
    .map((sequence) => sequence.trim())
    .filter((sequence) => /[A-Za-z]{2,}/.test(sequence))
    .join('\n');

  if (looksLikeReadableText(collapsed)) {
    return normalizeExtractedText(collapsed);
  }

  return '';
}

function parseTextLikeFile(filePath, extension) {
  const rawText = fs.readFileSync(filePath, 'utf-8');

  if (extension === '.rtf') {
    return normalizeExtractedText(stripRtfMarkup(rawText));
  }

  if (extension === '.html' || extension === '.htm' || extension === '.xml') {
    return normalizeExtractedText(stripHtmlTags(rawText));
  }

  return normalizeExtractedText(rawText);
}

async function extractTextFromFile(filePath, mimetype, originalName) {
  const lowerName = String(originalName || '').toLowerCase();
  const extension = getFileExtension(lowerName);
  const fileBuffer = fs.readFileSync(filePath);

  try {
    if (mimetype === 'application/pdf' || lowerName.endsWith('.pdf')) {
      return await parsePDF(filePath);
    }

    if (
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || lowerName.endsWith('.docx')
    ) {
      return await parseDOCX(filePath);
    }

    if (mimetype === 'text/plain' || TEXT_LIKE_EXTENSIONS.has(extension)) {
      const parsedText = parseTextLikeFile(filePath, extension);
      if (parsedText) {
        return parsedText;
      }
    }

    if (mimetype === 'application/msword' || lowerName.endsWith('.doc')) {
      const docFallbackText = extractReadableTextFromBuffer(fileBuffer);
      if (docFallbackText) {
        return docFallbackText;
      }
    }

    if (String(mimetype || '').startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) {
      throw new Error('Image files are accepted, but OCR is not available yet for image-only CVs');
    }

    const genericText = extractReadableTextFromBuffer(fileBuffer);
    if (genericText) {
      return genericText;
    }

    throw new Error('We accepted the file upload, but could not extract readable text from this file');
  } catch (error) {
    throw new Error(`Failed to parse file: ${error.message}`);
  }
}

// =========================
// ATS + TEMPLATE HELPERS
// =========================

const TEMPLATE_CONFIGS = {
  1: {
    name: 'Professional Classic',
    headerFill: '#ffffff',
    headerText: '#111827',
    sectionTitle: '#111827',
    sectionRule: '#cbd5e1',
    roleText: '#111827',
    metaText: '#475569',
    bodyText: '#111827',
    accent: '#0f4fa8',
    subtleFill: '#f8fafc',
    badgeFill: '#e2e8f0',
    footerText: '#64748b'
  },
  2: {
    name: 'Modern Blue',
    headerFill: '#0f4fa8',
    headerText: '#ffffff',
    sectionTitle: '#0f4fa8',
    sectionRule: '#bfdbfe',
    roleText: '#0b3b7a',
    metaText: '#475569',
    bodyText: '#0f172a',
    accent: '#16a34a',
    subtleFill: '#eff6ff',
    badgeFill: '#dbeafe',
    footerText: '#64748b'
  },
  3: {
    name: 'Executive Slate',
    headerFill: '#1f2937',
    headerText: '#ffffff',
    sectionTitle: '#1f2937',
    sectionRule: '#d4af37',
    roleText: '#111827',
    metaText: '#4b5563',
    bodyText: '#111827',
    accent: '#d4af37',
    subtleFill: '#f8fafc',
    badgeFill: '#e5e7eb',
    footerText: '#6b7280'
  }
};

function safeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => safeText(item)).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\n;|]+/)
      .map((item) => safeText(item))
      .filter(Boolean);
  }

  return [];
}

function normalizeDescriptionToBullets(text) {
  const cleaned = safeText(text);
  if (!cleaned) return [];

  const lineSplit = cleaned
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);

  if (lineSplit.length > 1) {
    return lineSplit;
  }

  const bulletSplit = cleaned
    .split(/[•???]+/)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);

  if (bulletSplit.length > 1) {
    return bulletSplit;
  }

  return [cleaned];
}

function normalizeCvData(cvData = {}) {
  const personalInput = cvData.personal || {};
  const personal = {
    name: safeText(personalInput.name) || 'Your Name',
    title: safeText(personalInput.title) || 'Professional Title',
    email: safeText(personalInput.email),
    phone: safeText(personalInput.phone),
    location: safeText(personalInput.location),
    linkedin: safeText(personalInput.linkedin),
    website: safeText(personalInput.website),
    summary: safeText(personalInput.summary)
  };

  const experience = Array.isArray(cvData.experience)
    ? cvData.experience
      .map((exp) => ({
        position: safeText(exp?.position),
        company: safeText(exp?.company),
        startDate: safeText(exp?.startDate),
        endDate: safeText(exp?.endDate),
        current: Boolean(exp?.current),
        description: safeText(exp?.description)
      }))
      .filter((exp) => exp.company || exp.position || exp.description)
    : [];

  const education = Array.isArray(cvData.education)
    ? cvData.education
      .map((edu) => ({
        institution: safeText(edu?.institution),
        degree: safeText(edu?.degree),
        field: safeText(edu?.field),
        graduationYear: safeText(edu?.graduationYear)
      }))
      .filter((edu) => edu.institution || edu.degree || edu.field)
    : [];

  return {
    personal,
    experience,
    education,
    skills: toArray(cvData.skills),
    certifications: toArray(cvData.certifications)
  };
}

function normalizeTemplateId(selectedTemplate) {
  const parsed = Number.parseInt(String(selectedTemplate), 10);
  return TEMPLATE_CONFIGS[parsed] ? parsed : 1;
}

function normalizeAtsText(text) {
  let atsText = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[•???]+/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  atsText = atsText
    .replace(/^\s*(summary|profile|professional profile)\s*:?$/gim, 'PROFESSIONAL SUMMARY')
    .replace(/^\s*(experience|work experience|employment history)\s*:?$/gim, 'WORK EXPERIENCE')
    .replace(/^\s*(education|academic background|qualifications?)\s*:?$/gim, 'EDUCATION')
    .replace(/^\s*(skills|technical skills|core skills|competencies)\s*:?$/gim, 'SKILLS')
    .replace(/^\s*(certifications?|licenses?)\s*:?$/gim, 'CERTIFICATIONS');

  if (!/\b(UAE|Saudi Arabia|Qatar|Bahrain|Kuwait|Oman)\b/i.test(atsText)) {
    atsText = `Preferred Locations: UAE | Saudi Arabia | Qatar | Bahrain | Kuwait | Oman\n\n${atsText}`;
  }

  return atsText;
}

// =========================
// PDF GENERATION FUNCTION
// =========================

function generatePDFFromData(rawCvData, fileName, selectedTemplate = 1) {
  return new Promise((resolve, reject) => {
    try {
      const cleanFileName = fileName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const pdfPath = path.join(pdfDir, `${cleanFileName}_${Date.now()}.pdf`);
      const templateId = normalizeTemplateId(selectedTemplate);
      const template = TEMPLATE_CONFIGS[templateId];
      const cvData = normalizeCvData(rawCvData);

      const doc = new PDFDocument({
        size: 'A4',
        margin: 42,
        bufferPages: true
      });

      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

      const leftX = doc.page.margins.left;
      const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const pageBottom = () => doc.page.height - doc.page.margins.bottom - 24;
      let y = doc.page.margins.top;

      function addPage() {
        doc.addPage();
        y = doc.page.margins.top;
      }

      function ensureSpace(estimatedHeight) {
        if (y + estimatedHeight > pageBottom()) {
          addPage();
        }
      }

      function drawSectionTitle(title) {
        ensureSpace(32);
        doc.font('Helvetica-Bold')
          .fontSize(11.5)
          .fillColor(template.sectionTitle)
          .text(title, leftX, y, { width: contentWidth });
        y += 16;
        doc.moveTo(leftX, y)
          .lineTo(leftX + contentWidth, y)
          .lineWidth(1.1)
          .strokeColor(template.sectionRule)
          .stroke();
        y += 10;
      }

      function drawParagraph(text, options = {}) {
        const fontSize = options.fontSize || 10.2;
        const color = options.color || template.bodyText;
        const lineGap = options.lineGap ?? 2;
        const bottomGap = options.bottomGap ?? 8;
        const paragraph = safeText(text);
        if (!paragraph) return;

        doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(fontSize)
          .fillColor(color);
        const textHeight = doc.heightOfString(paragraph, { width: contentWidth, lineGap });
        ensureSpace(textHeight + bottomGap);
        doc.text(paragraph, leftX, y, { width: contentWidth, lineGap });
        y += textHeight + bottomGap;
      }

      if (template.headerFill) {
        doc.rect(0, 0, doc.page.width, template.headerHeight)
          .fill(template.headerFill);
      }

      const headerStartY = template.headerFill ? 30 : 24;
      doc.font('Helvetica-Bold')
        .fontSize(24)
        .fillColor(template.headerText)
        .text(cvData.personal.name, leftX, headerStartY, { width: contentWidth });

      doc.font('Helvetica')
        .fontSize(12.5)
        .fillColor(template.headerText)
        .text(cvData.personal.title, leftX, headerStartY + 32, { width: contentWidth });

      const contactItems = [
        cvData.personal.location,
        cvData.personal.email,
        cvData.personal.phone,
        cvData.personal.linkedin,
        cvData.personal.website
      ].filter(Boolean);

      if (contactItems.length > 0) {
        doc.font('Helvetica')
          .fontSize(9.6)
          .fillColor(template.headerText)
          .text(contactItems.join(' | '), leftX, headerStartY + 52, { width: contentWidth });
      }

      if (!template.headerFill) {
        doc.moveTo(leftX, headerStartY + 74)
          .lineTo(leftX + contentWidth, headerStartY + 74)
          .lineWidth(1)
          .strokeColor(template.sectionRule)
          .stroke();
      }

      y = template.headerFill ? template.headerHeight + 14 : headerStartY + 88;

      if (cvData.personal.summary) {
        drawSectionTitle('PROFESSIONAL SUMMARY');
        drawParagraph(cvData.personal.summary, { bottomGap: 12 });
      }

      if (cvData.experience.length > 0) {
        drawSectionTitle('WORK EXPERIENCE');

        cvData.experience.forEach((exp) => {
          const roleLine = [exp.position, exp.company].filter(Boolean).join(' - ');
          const dateLine = [exp.startDate, exp.current ? 'Present' : exp.endDate]
            .filter(Boolean)
            .join(' to ');

          drawParagraph(roleLine || 'Role', {
            bold: true,
            color: template.roleText,
            fontSize: 11,
            bottomGap: 3
          });

          if (dateLine) {
            drawParagraph(dateLine, {
              color: template.metaText,
              fontSize: 9.6,
              bottomGap: 5
            });
          }

          const bullets = normalizeDescriptionToBullets(exp.description);
          bullets.forEach((line) => {
            drawParagraph(`- ${line}`, {
              color: template.bodyText,
              fontSize: 10,
              bottomGap: 3
            });
          });

          y += 4;
        });
      }

      if (cvData.education.length > 0) {
        drawSectionTitle('EDUCATION');

        cvData.education.forEach((edu) => {
          const degreeLine = [edu.degree, edu.field].filter(Boolean).join(' in ');
          const meta = [edu.institution, edu.graduationYear].filter(Boolean).join(' | ');

          drawParagraph(degreeLine || 'Qualification', {
            bold: true,
            color: template.roleText,
            fontSize: 10.8,
            bottomGap: 3
          });

          drawParagraph(meta, {
            color: template.metaText,
            fontSize: 9.8,
            bottomGap: 8
          });
        });
      }

      if (cvData.skills.length > 0) {
        drawSectionTitle('SKILLS');
        drawParagraph(cvData.skills.join(', '), { bottomGap: 10 });
      }

      if (cvData.certifications.length > 0) {
        drawSectionTitle('CERTIFICATIONS');
        cvData.certifications.forEach((cert) => {
          drawParagraph(`- ${cert}`, { bottomGap: 4 });
        });
      }

      // Footer line with Gulf keywords
      const pageCount = doc.bufferedPageRange().count;
      for (let i = 0; i < pageCount; i++) {
        doc.switchToPage(i);
        doc.font('Helvetica')
          .fontSize(7.8)
          .fillColor('#9ca3af')
          .text('Gulf CV Expert | ATS Optimized | UAE | Saudi Arabia | Qatar | Bahrain | Kuwait | Oman', 40, 750);
      }

      doc.end();

      stream.on('finish', () => {
        resolve(pdfPath);
      });

      stream.on('error', (err) => {
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function normalizeDescriptionToBullets(text) {
  const cleaned = safeText(text);
  if (!cleaned) return [];

  const normalized = cleaned
    .replace(/[\u2022\u2023\u25E6\u2043\u2219\u25AA\u25CF]+/gu, '\n')
    .replace(/\s+[|;]\s+/g, '\n');

  const lineSplit = normalized
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);

  if (lineSplit.length > 1) {
    return lineSplit;
  }

  const bulletSplit = normalized
    .split(/\s{2,}/)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);

  if (bulletSplit.length > 1) {
    return bulletSplit;
  }

  return [cleaned];
}

function normalizeAtsText(text) {
  let atsText = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[\u2022\u2023\u25E6\u2043\u2219\u25AA\u25CF]+/gu, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  atsText = atsText
    .replace(/^\s*(summary|profile|professional profile)\s*:?$/gim, 'PROFESSIONAL SUMMARY')
    .replace(/^\s*(experience|work experience|employment history)\s*:?$/gim, 'WORK EXPERIENCE')
    .replace(/^\s*(education|academic background|qualifications?)\s*:?$/gim, 'EDUCATION')
    .replace(/^\s*(skills|technical skills|core skills|competencies)\s*:?$/gim, 'SKILLS')
    .replace(/^\s*(certifications?|licenses?)\s*:?$/gim, 'CERTIFICATIONS');

  if (!/\b(UAE|Saudi Arabia|Qatar|Bahrain|Kuwait|Oman)\b/i.test(atsText)) {
    atsText = `Preferred Locations: UAE | Saudi Arabia | Qatar | Bahrain | Kuwait | Oman\n\n${atsText}`;
  }

  return atsText;
}

function formatMonthYear(value) {
  const cleaned = safeText(value);
  if (!cleaned) return '';

  const match = cleaned.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    return cleaned;
  }

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIndex = Number.parseInt(match[2], 10) - 1;

  if (monthIndex < 0 || monthIndex > 11) {
    return cleaned;
  }

  return `${months[monthIndex]} ${match[1]}`;
}

function formatDateRange(startDate, endDate, current) {
  const startLabel = formatMonthYear(startDate);
  const endLabel = current ? 'Present' : formatMonthYear(endDate);
  return [startLabel, endLabel].filter(Boolean).join(' - ');
}

function getContactLine(personal) {
  return [
    personal.location,
    personal.email,
    personal.phone,
    personal.linkedin,
    personal.website
  ].filter(Boolean).join(' | ');
}

function addFooterToAllPages(doc, templateName, footerColor) {
  const pageRange = doc.bufferedPageRange();
  const footerText = `${templateName} | Gulf CV Expert | ATS Optimized for Gulf Jobs`;

  for (let pageIndex = 0; pageIndex < pageRange.count; pageIndex++) {
    doc.switchToPage(pageIndex);
    doc.font('Helvetica')
      .fontSize(7.8)
      .fillColor(footerColor)
      .text(footerText, 40, doc.page.height - 28, {
        width: doc.page.width - 80,
        align: 'center'
      });
  }
}

function drawPdfTagRows(doc, items, options) {
  const tags = (Array.isArray(items) ? items : [])
    .map((item) => safeText(item))
    .filter(Boolean);

  if (tags.length === 0) {
    return;
  }

  const {
    state,
    leftX,
    contentWidth,
    pageBottom,
    fillColor = '#eff6ff',
    strokeColor = '#dbeafe',
    textColor = '#0f3f86',
    fontSize = 9,
    pillHeight = 22,
    paddingX = 10,
    gapX = 8,
    gapY = 8,
    bottomGap = 10
  } = options;

  let x = leftX;
  let y = state.y;

  doc.font('Helvetica-Bold')
    .fontSize(fontSize);

  tags.forEach((tag) => {
    const textWidth = doc.widthOfString(tag);
    const pillWidth = Math.min(contentWidth, textWidth + (paddingX * 2));

    if (x !== leftX && x + pillWidth > leftX + contentWidth) {
      x = leftX;
      y += pillHeight + gapY;
    }

    if (y + pillHeight > pageBottom()) {
      state.addPage();
      x = leftX;
      y = state.y;
    }

    doc.roundedRect(x, y, pillWidth, pillHeight, 11)
      .lineWidth(1)
      .fillAndStroke(fillColor, strokeColor);

    doc.font('Helvetica-Bold')
      .fontSize(fontSize)
      .fillColor(textColor)
      .text(tag, x + paddingX, y + 7, {
        width: pillWidth - (paddingX * 2),
        align: 'center'
      });

    x += pillWidth + gapX;
  });

  state.y = y + pillHeight + bottomGap;
}

function generatePDFBuffer(rawCvData, selectedTemplate = 1) {
  return new Promise((resolve, reject) => {
    try {
      const templateId = normalizeTemplateId(selectedTemplate);
      const template = TEMPLATE_CONFIGS[templateId];
      const cvData = normalizeCvData(rawCvData);

      const doc = new PDFDocument({
        size: 'A4',
        margin: 42,
        bufferPages: true
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const leftX = doc.page.margins.left;
      const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const pageBottom = () => doc.page.height - doc.page.margins.bottom - 34;

      function createTextWriter(state) {
        return function drawText(text, options = {}) {
          const value = safeText(text);
          if (!value) return 0;

          const font = options.bold ? 'Helvetica-Bold' : 'Helvetica';
          const fontSize = options.fontSize || 10;
          const color = options.color || template.bodyText;
          const lineGap = options.lineGap ?? 2;
          const bottomGap = options.bottomGap ?? 6;
          const width = options.width || contentWidth;
          const x = options.x ?? leftX;
          const align = options.align || 'left';
          const textHeight = doc.heightOfString(value, { width, lineGap, align });

          if (state.y + textHeight + bottomGap > pageBottom()) {
            state.addPage();
          }

          doc.font(font)
            .fontSize(fontSize)
            .fillColor(color)
            .text(value, x, state.y, { width, lineGap, align });

          state.y += textHeight + bottomGap;
          return textHeight;
        };
      }

      if (templateId === 2) {
        const state = {
          y: 140,
          addPage: () => {
            doc.addPage();
            doc.rect(0, 0, doc.page.width, 34).fill(template.headerFill);
            doc.rect(0, 34, doc.page.width, 3).fill(template.accent);
            state.y = 52;
          }
        };
        const drawText = createTextWriter(state);

        doc.rect(0, 0, doc.page.width, 118).fill(template.headerFill);
        doc.rect(0, 113, doc.page.width, 5).fill(template.accent);

        doc.font('Helvetica-Bold')
          .fontSize(24)
          .fillColor(template.headerText)
          .text(cvData.personal.name, leftX, 28, { width: contentWidth });

        doc.font('Helvetica')
          .fontSize(12.5)
          .fillColor('#dbeafe')
          .text(cvData.personal.title, leftX, 60, { width: contentWidth });

        doc.font('Helvetica')
          .fontSize(9.4)
          .fillColor('#eff6ff')
          .text(getContactLine(cvData.personal), leftX, 84, { width: contentWidth });

        if (cvData.personal.summary) {
          const summaryHeight = doc.heightOfString(cvData.personal.summary, {
            width: contentWidth - 24,
            lineGap: 2
          });
          const boxHeight = summaryHeight + 24;

          if (state.y + boxHeight + 12 > pageBottom()) {
            state.addPage();
          }

          doc.roundedRect(leftX, state.y, contentWidth, boxHeight, 10)
            .fill(template.subtleFill);

          doc.font('Helvetica-Bold')
            .fontSize(9.6)
            .fillColor(template.sectionTitle)
            .text('PROFILE SNAPSHOT', leftX + 12, state.y + 8, { width: contentWidth - 24 });

          doc.font('Helvetica')
            .fontSize(10)
            .fillColor(template.bodyText)
            .text(cvData.personal.summary, leftX + 12, state.y + 24, {
              width: contentWidth - 24,
              lineGap: 2
            });

          state.y += boxHeight + 14;
        }

        const drawSection = (title) => {
          if (state.y + 30 > pageBottom()) {
            state.addPage();
          }

          doc.roundedRect(leftX, state.y - 2, 138, 19, 5)
            .fill(template.badgeFill);

          doc.font('Helvetica-Bold')
            .fontSize(10)
            .fillColor(template.sectionTitle)
            .text(title, leftX + 10, state.y + 2, { width: 118 });

          state.y += 23;

          doc.moveTo(leftX, state.y)
            .lineTo(leftX + contentWidth, state.y)
            .lineWidth(1.2)
            .strokeColor(template.sectionRule)
            .stroke();

          state.y += 10;
        };

        const drawCardEntry = (title, subtitle, lines = []) => {
          doc.font('Helvetica-Bold').fontSize(11.2);
          const titleHeight = doc.heightOfString(safeText(title), { width: contentWidth - 36 });

          doc.font('Helvetica').fontSize(9.5);
          const subtitleHeight = subtitle
            ? doc.heightOfString(safeText(subtitle), { width: contentWidth - 36 })
            : 0;

          doc.font('Helvetica').fontSize(10);
          const bodyText = lines.map((line) => `- ${line}`).join('\n');
          const bodyHeight = bodyText
            ? doc.heightOfString(bodyText, { width: contentWidth - 36, lineGap: 2 })
            : 0;

          const cardHeight = 18 + titleHeight + subtitleHeight + bodyHeight + (bodyHeight ? 8 : 2);

          if (state.y + cardHeight + 10 > pageBottom()) {
            state.addPage();
          }

          doc.roundedRect(leftX, state.y, contentWidth, cardHeight, 10)
            .lineWidth(1)
            .fillAndStroke('#ffffff', '#dbeafe');

          doc.roundedRect(leftX, state.y, 8, cardHeight, 8)
            .fill(template.sectionTitle);

          let cardY = state.y + 12;

          doc.font('Helvetica-Bold')
            .fontSize(11.2)
            .fillColor(template.roleText)
            .text(safeText(title), leftX + 18, cardY, { width: contentWidth - 36 });
          cardY += titleHeight + 3;

          if (subtitle) {
            doc.font('Helvetica')
              .fontSize(9.5)
              .fillColor(template.metaText)
              .text(safeText(subtitle), leftX + 18, cardY, { width: contentWidth - 36 });
            cardY += subtitleHeight + 6;
          }

          if (bodyText) {
            doc.font('Helvetica')
              .fontSize(10)
              .fillColor(template.bodyText)
              .text(bodyText, leftX + 18, cardY, {
                width: contentWidth - 36,
                lineGap: 2
              });
          }

          state.y += cardHeight + 12;
        };

        if (cvData.experience.length > 0) {
          drawSection('WORK EXPERIENCE');
          cvData.experience.forEach((exp) => {
            drawCardEntry(
              [exp.position, exp.company].filter(Boolean).join(' - '),
              formatDateRange(exp.startDate, exp.endDate, exp.current),
              normalizeDescriptionToBullets(exp.description)
            );
          });
        }

        if (cvData.education.length > 0) {
          drawSection('EDUCATION');
          cvData.education.forEach((edu) => {
            drawCardEntry(
              [edu.degree, edu.field].filter(Boolean).join(' in '),
              [edu.institution, edu.graduationYear].filter(Boolean).join(' | '),
              []
            );
          });
        }

        if (cvData.skills.length > 0) {
          drawSection('CORE SKILLS');
          drawPdfTagRows(doc, cvData.skills, {
            state,
            leftX,
            contentWidth,
            pageBottom,
            fillColor: '#eff6ff',
            strokeColor: '#bfdbfe',
            textColor: '#0b3b7a'
          });
        }

        if (cvData.certifications.length > 0) {
          drawSection('CERTIFICATIONS');
          cvData.certifications.forEach((cert) => {
            drawText(`- ${cert}`, { bottomGap: 4 });
          });
        }
      } else if (templateId === 3) {
        const state = {
          y: 120,
          addPage: () => {
            doc.addPage();
            doc.rect(0, 0, doc.page.width, 28).fill(template.headerFill);
            doc.rect(0, 28, doc.page.width, 3).fill(template.accent);
            state.y = 48;
          }
        };
        const drawText = createTextWriter(state);

        doc.rect(0, 0, doc.page.width, 98).fill(template.headerFill);
        doc.rect(0, 94, doc.page.width, 4).fill(template.accent);

        doc.font('Helvetica-Bold')
          .fontSize(24)
          .fillColor(template.headerText)
          .text(cvData.personal.name, leftX, 24, { width: contentWidth });

        doc.font('Helvetica-Bold')
          .fontSize(12)
          .fillColor(template.accent)
          .text(cvData.personal.title, leftX, 57, { width: contentWidth });

        doc.font('Helvetica')
          .fontSize(9.3)
          .fillColor('#e5e7eb')
          .text(getContactLine(cvData.personal), leftX, 76, { width: contentWidth });

        if (cvData.personal.summary) {
          const summaryHeight = doc.heightOfString(cvData.personal.summary, {
            width: contentWidth - 28,
            lineGap: 2
          });
          const boxHeight = summaryHeight + 26;

          if (state.y + boxHeight + 12 > pageBottom()) {
            state.addPage();
          }

          doc.roundedRect(leftX, state.y, contentWidth, boxHeight, 8)
            .lineWidth(1)
            .fillAndStroke(template.subtleFill, '#e5e7eb');

          doc.font('Helvetica-Bold')
            .fontSize(9.6)
            .fillColor(template.sectionTitle)
            .text('EXECUTIVE SUMMARY', leftX + 14, state.y + 8, { width: contentWidth - 28 });

          doc.font('Helvetica')
            .fontSize(10)
            .fillColor(template.bodyText)
            .text(cvData.personal.summary, leftX + 14, state.y + 24, {
              width: contentWidth - 28,
              lineGap: 2
            });

          state.y += boxHeight + 14;
        }

        const drawSection = (title) => {
          if (state.y + 28 > pageBottom()) {
            state.addPage();
          }

          doc.font('Helvetica-Bold')
            .fontSize(11)
            .fillColor(template.sectionTitle)
            .text(title, leftX, state.y, { width: contentWidth });

          state.y += 16;

          doc.moveTo(leftX, state.y)
            .lineTo(leftX + contentWidth, state.y)
            .lineWidth(1.1)
            .strokeColor(template.sectionRule)
            .stroke();

          state.y += 10;
        };

        const drawExecutiveEntry = (title, subtitle, lines = []) => {
          doc.font('Helvetica-Bold').fontSize(11.1);
          const titleHeight = doc.heightOfString(safeText(title), { width: contentWidth - 32 });

          doc.font('Helvetica').fontSize(9.5);
          const subtitleHeight = subtitle
            ? doc.heightOfString(safeText(subtitle), { width: contentWidth - 32 })
            : 0;

          doc.font('Helvetica').fontSize(10);
          const bodyText = lines.map((line) => `- ${line}`).join('\n');
          const bodyHeight = bodyText
            ? doc.heightOfString(bodyText, { width: contentWidth - 32, lineGap: 2 })
            : 0;

          const boxHeight = 16 + titleHeight + subtitleHeight + bodyHeight + (bodyHeight ? 8 : 4);

          if (state.y + boxHeight + 10 > pageBottom()) {
            state.addPage();
          }

          doc.roundedRect(leftX, state.y, contentWidth, boxHeight, 8)
            .lineWidth(1)
            .fillAndStroke('#ffffff', '#d1d5db');

          doc.rect(leftX, state.y, 5, boxHeight)
            .fill(template.accent);

          let cardY = state.y + 10;

          doc.font('Helvetica-Bold')
            .fontSize(11.1)
            .fillColor(template.roleText)
            .text(safeText(title), leftX + 16, cardY, { width: contentWidth - 28 });
          cardY += titleHeight + 3;

          if (subtitle) {
            doc.font('Helvetica')
              .fontSize(9.5)
              .fillColor(template.metaText)
              .text(safeText(subtitle), leftX + 16, cardY, { width: contentWidth - 28 });
            cardY += subtitleHeight + 6;
          }

          if (bodyText) {
            doc.font('Helvetica')
              .fontSize(10)
              .fillColor(template.bodyText)
              .text(bodyText, leftX + 16, cardY, {
                width: contentWidth - 28,
                lineGap: 2
              });
          }

          state.y += boxHeight + 12;
        };

        if (cvData.experience.length > 0) {
          drawSection('CAREER EXPERIENCE');
          cvData.experience.forEach((exp) => {
            drawExecutiveEntry(
              [exp.position, exp.company].filter(Boolean).join(' - '),
              formatDateRange(exp.startDate, exp.endDate, exp.current),
              normalizeDescriptionToBullets(exp.description)
            );
          });
        }

        if (cvData.education.length > 0) {
          drawSection('EDUCATION');
          cvData.education.forEach((edu) => {
            drawExecutiveEntry(
              [edu.degree, edu.field].filter(Boolean).join(' in '),
              [edu.institution, edu.graduationYear].filter(Boolean).join(' | '),
              []
            );
          });
        }

        if (cvData.skills.length > 0) {
          drawSection('KEY SKILLS');
          drawPdfTagRows(doc, cvData.skills, {
            state,
            leftX,
            contentWidth,
            pageBottom,
            fillColor: '#fff8e7',
            strokeColor: '#ead7a1',
            textColor: '#8a6d1f'
          });
        }

        if (cvData.certifications.length > 0) {
          drawSection('CERTIFICATIONS');
          cvData.certifications.forEach((cert) => {
            drawText(`- ${cert}`, { bottomGap: 4 });
          });
        }
      } else {
        const state = {
          y: 46,
          addPage: () => {
            doc.addPage();
            state.y = 46;
          }
        };
        const drawText = createTextWriter(state);

        drawText(cvData.personal.name, {
          bold: true,
          fontSize: 25,
          color: template.headerText,
          align: 'center',
          bottomGap: 4
        });

        drawText(cvData.personal.title, {
          fontSize: 12.5,
          color: template.metaText,
          align: 'center',
          bottomGap: 4
        });

        const contactLine = getContactLine(cvData.personal);
        if (contactLine) {
          doc.roundedRect(leftX, state.y - 2, contentWidth, 24, 12)
            .lineWidth(1)
            .fillAndStroke('#f8fbff', '#d7e6fb');
          doc.font('Helvetica')
            .fontSize(9.2)
            .fillColor(template.metaText)
            .text(contactLine, leftX + 12, state.y + 6, {
              width: contentWidth - 24,
              align: 'center'
            });
          state.y += 34;
        }

        const drawSection = (title) => {
          if (state.y + 30 > pageBottom()) {
            state.addPage();
          }

          doc.font('Helvetica-Bold')
            .fontSize(11.5)
            .fillColor(template.sectionTitle)
            .text(title, leftX, state.y, { width: contentWidth });

          state.y += 16;

          doc.moveTo(leftX, state.y)
            .lineTo(leftX + contentWidth, state.y)
            .lineWidth(1)
            .strokeColor(template.sectionRule)
            .stroke();

          state.y += 10;
        };

        if (cvData.personal.summary) {
          drawSection('PROFESSIONAL SUMMARY');
          const summaryHeight = doc.heightOfString(cvData.personal.summary, {
            width: contentWidth - 24,
            lineGap: 2
          });
          const summaryBoxHeight = summaryHeight + 24;

          if (state.y + summaryBoxHeight + 12 > pageBottom()) {
            state.addPage();
          }

          doc.roundedRect(leftX, state.y, contentWidth, summaryBoxHeight, 12)
            .lineWidth(1)
            .fillAndStroke('#ffffff', '#dbeafe');
          doc.font('Helvetica')
            .fontSize(10)
            .fillColor(template.bodyText)
            .text(cvData.personal.summary, leftX + 12, state.y + 12, {
              width: contentWidth - 24,
              lineGap: 2
            });
          state.y += summaryBoxHeight + 12;
        }

        if (cvData.experience.length > 0) {
          drawSection('WORK EXPERIENCE');
          cvData.experience.forEach((exp) => {
            drawText([exp.position, exp.company].filter(Boolean).join(' - '), {
              bold: true,
              fontSize: 11.2,
              color: template.roleText,
              bottomGap: 2
            });

            drawText(formatDateRange(exp.startDate, exp.endDate, exp.current), {
              fontSize: 9.5,
              color: template.metaText,
              bottomGap: 5
            });

            normalizeDescriptionToBullets(exp.description).forEach((line) => {
              drawText(`- ${line}`, {
                fontSize: 10,
                color: template.bodyText,
                bottomGap: 3
              });
            });

            state.y += 4;
          });
        }

        if (cvData.education.length > 0) {
          drawSection('EDUCATION');
          cvData.education.forEach((edu) => {
            drawText([edu.degree, edu.field].filter(Boolean).join(' in '), {
              bold: true,
              fontSize: 10.8,
              color: template.roleText,
              bottomGap: 2
            });

            drawText([edu.institution, edu.graduationYear].filter(Boolean).join(' | '), {
              fontSize: 9.6,
              color: template.metaText,
              bottomGap: 8
            });
          });
        }

        if (cvData.skills.length > 0) {
          drawSection('SKILLS');
          drawPdfTagRows(doc, cvData.skills, {
            state,
            leftX,
            contentWidth,
            pageBottom,
            fillColor: '#eff6ff',
            strokeColor: '#dbeafe',
            textColor: '#0f3f86'
          });
        }

        if (cvData.certifications.length > 0) {
          drawSection('CERTIFICATIONS');
          cvData.certifications.forEach((cert) => {
            drawText(`- ${cert}`, { bottomGap: 4 });
          });
        }
      }

      addFooterToAllPages(doc, template.name, template.footerText);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// =========================
// API ENDPOINTS
// =========================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running', timestamp: new Date() });
});

// Upload and parse CV
app.post('/api/convert-cv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log(`Processing file: ${req.file.originalname}`);

    const text = await extractTextFromFile(
      req.file.path,
      req.file.mimetype,
      req.file.originalname
    );

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      text,
      fileName: req.file.originalname,
      characterCount: text.length,
      wordCount: text.split(/\s+/).length
    });
  } catch (error) {
    console.error('Error:', error);

    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({ error: error.message });
  }
});

// Convert to ATS format
app.post('/api/convert-to-ats', (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    const atsText = normalizeAtsText(text);

    const improvements = [
      'Formatted for ATS system compatibility',
      'Removed unsupported special characters',
      'Standardized section headers',
      'Normalized bullet point formatting',
      'Added Gulf market location keywords',
      'Improved readability for recruiters'
    ];

    res.json({
      success: true,
      atsText,
      improvements,
      originalLength: text.length,
      atsLength: atsText.length
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate PDF from CV data
app.post('/api/generate-pdf', async (req, res) => {
  try {
    const { cvData, fileName, selectedTemplate } = req.body;

    if (!cvData || !fileName) {
      return res.status(400).json({ error: 'Missing required data' });
    }

    const templateId = normalizeTemplateId(selectedTemplate);
    const safeFileName = String(fileName).replace(/[^a-zA-Z0-9_-]/g, '_');
    console.log(`Generating PDF: ${safeFileName} with template ${templateId}`);

    const pdfBuffer = await generatePDFBuffer(cvData, templateId);
    const downloadName = `${safeFileName}_CV_ATS.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-store');

    console.log('PDF generated successfully');
    res.end(pdfBuffer);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Validate CV data
app.post('/api/validate-cv', (req, res) => {
  try {
    const { cvData } = req.body;
    const errors = [];

    if (!cvData.personal?.name) errors.push('Name is required');
    if (!cvData.personal?.email) errors.push('Email is required');

    if (errors.length > 0) {
      return res.status(400).json({ valid: false, errors });
    }

    res.json({ valid: true, message: 'CV data is valid' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get server info
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Gulf CV Expert Backend',
    version: '1.1.0',
    templates: [
      TEMPLATE_CONFIGS[1].name,
      TEMPLATE_CONFIGS[2].name,
      TEMPLATE_CONFIGS[3].name
    ],
    features: [
      'CV file upload (PDF, DOCX, DOC, TXT)',
      'Text extraction',
      'ATS conversion',
      'PDF generation with 3 ATS templates',
      'CV data validation'
    ],
    endpoints: [
      'POST /api/convert-cv - Upload and parse CV',
      'POST /api/convert-to-ats - Convert to ATS format',
      'POST /api/generate-pdf - Generate PDF',
      'POST /api/validate-cv - Validate CV data',
      'GET /api/health - Server health check',
      'GET /api/info - Server info'
    ]
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

// Start server
app.listen(PORT, () => {
  console.log('\n========================================');
  console.log('  Gulf CV Expert Backend Started');
  console.log('========================================');
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
  console.log(`Info: http://localhost:${PORT}/api/info`);
  console.log('========================================\n');
});
