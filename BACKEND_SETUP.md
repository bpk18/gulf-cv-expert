# Gulf CV Expert - Backend Setup Guide

## Prerequisites
1. **Node.js** (v14 or higher) - Download from https://nodejs.org
2. **Git** (optional but recommended)
3. A terminal/command prompt

## Step-by-Step Setup

### Step 1: Initialize Node.js Project
```bash
cd c:\Users\User\gulf-cv-landing
npm init -y
```

### Step 2: Install Dependencies
```bash
npm install express multer cors pdfkit pdf-parse mammoth dotenv
npm install --save-dev nodemon
```

### Step 3: Create .env File
Create a file named `.env` in the project root:
```
PORT=3000
NODE_ENV=development
```

### Step 4: Start Server
```bash
npm start
```

The server will run on `http://localhost:3000`

## Project Structure
```
gulf-cv-landing/
├── server.js (main backend file)
├── package.json
├── .env
├── uploads/ (temporary file storage)
├── generated-pdfs/ (PDF output storage)
└── (HTML/CSS/JS frontend files)
```

## API Endpoints

### 1. Upload & Parse CV
**POST** `/api/convert-cv`
- Accepts: PDF, DOCX, DOC, TXT files
- Returns: Extracted text content

### 2. Convert to ATS Format
**POST** `/api/convert-to-ats`
- Input: Raw CV text
- Returns: ATS-formatted text + improvements list

### 3. Generate PDF
**POST** `/api/generate-pdf`
- Input: CV data + template choice
- Returns: PDF file download

## File Upload Support
✅ PDF files (.pdf)
✅ Word documents (.docx, .doc)
✅ Text files (.txt)
✅ Max file size: 5MB

## Features
- ✅ Multi-format file parsing
- ✅ ATS conversion with improvements
- ✅ Professional PDF generation
- ✅ Template support (3 templates)
- ✅ CORS enabled for frontend
- ✅ Error handling
- ✅ Auto-cleanup of temporary files

## Troubleshooting

### Port Already in Use
```bash
Change PORT in .env file
```

### Module Not Found
```bash
npm install
```

### PDF Generation Issues
```bash
npm install pdfkit --save
```

## Next Steps
1. Run `npm start`
2. Test endpoints using Postman or curl
3. Frontend will automatically call these endpoints
