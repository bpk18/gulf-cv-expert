# 🚀 Gulf CV Expert - Backend Setup Guide

## Complete Step-by-Step Instructions

### ✅ Prerequisites Check
Before starting, you need:
- [ ] Windows (or Mac/Linux)
- [ ] Node.js v14+ installed ([Download here](https://nodejs.org))
- [ ] A terminal/command prompt

### 📋 Check Node.js Installation
Open Command Prompt and run:
```bash
node --version
npm --version
```

Both should show version numbers. If not, install Node.js from https://nodejs.org

---

## 🎯 Quick Start (3 Steps)

### Step 1: Run Setup Script
Double-click `setup.bat` in the gulf-cv-landing folder

This will:
- Install all dependencies
- Create `.env` file
- Create necessary directories

### Step 2: Start the Server
Double-click `start.bat` in the gulf-cv-landing folder

You should see:
```
╔═══════════════════════════════════════╗
║   Gulf CV Expert - Backend Started    ║
╠═══════════════════════════════════════╣
║ Server: http://localhost:3000         ║
║ API: http://localhost:3000/api        ║
║ Health: http://localhost:3000/api/health
║ Info: http://localhost:3000/api/info  ║
╚═══════════════════════════════════════╝
```

### Step 3: Open Frontend
Open your browser and go to:
- `http://localhost:3000`

---

## 📁 Project Structure
```
gulf-cv-landing/
├── server.js                  # Main backend file
├── package.json              # Dependencies
├── .env                      # Configuration (AUTO-CREATED)
├── setup.bat                 # Setup script
├── start.bat                 # Start script
├── uploads/                  # Temporary files (AUTO-CREATED)
├── generated-pdfs/           # PDF output (AUTO-CREATED)
├── cv-options.html          # Frontend
├── cv-converter.html        # Frontend
├── cv-builder.html          # Frontend
└── index.html               # Frontend
```

---

## 🔧 Manual Setup (If Scripts Don't Work)

### Step 1: Install Node.js Packages
Open Command Prompt in the gulf-cv-landing folder:
```bash
npm install
```

### Step 2: Create .env File
Create a file named `.env` in gulf-cv-landing folder:
```
PORT=3000
NODE_ENV=development
```

### Step 3: Create Directories
```bash
mkdir uploads
mkdir generated-pdfs
```

### Step 4: Start Server
```bash
npm start
```

---

## 🌐 API Endpoints

### 1. **Upload & Parse CV**
- **URL**: `POST http://localhost:3000/api/convert-cv`
- **Accepts**: PDF, DOCX, DOC, TXT (max 5MB)
- **Returns**: Extracted text content

Example using curl:
```bash
curl -F "file=@resume.pdf" http://localhost:3000/api/convert-cv
```

### 2. **Convert to ATS Format**
- **URL**: `POST http://localhost:3000/api/convert-to-ats`
- **Input**: CV text
- **Returns**: ATS-formatted text + improvements

```bash
curl -X POST http://localhost:3000/api/convert-to-ats \
  -H "Content-Type: application/json" \
  -d '{"text":"Your CV content..."}'
```

### 3. **Generate PDF**
- **URL**: `POST http://localhost:3000/api/generate-pdf`
- **Input**: CV data + template choice
- **Returns**: PDF file download

### 4. **Health Check**
- **URL**: `GET http://localhost:3000/api/health`
- **Returns**: Server status

### 5. **Server Info**
- **URL**: `GET http://localhost:3000/api/info`
- **Returns**: All endpoints and features

---

## 🐛 Troubleshooting

### ❌ "Port 3000 already in use"
**Solution**: Edit `.env` file:
```
PORT=3001
```
Then restart server

### ❌ "npm: command not found"
**Solution**: Node.js not installed
- Download from https://nodejs.org
- Run installer
- Restart command prompt

### ❌ "Cannot find module 'express'"
**Solution**: Run npm install
```bash
npm install
```

### ❌ "File not found"
**Solution**: Make sure you're in the gulf-cv-landing directory
```bash
cd c:\Users\User\gulf-cv-landing
```

### ❌ CORS errors in browser
**Solution**: Make sure backend is running on http://localhost:3000

### ❌ PDF generation fails
**Solution**: Install pdfkit
```bash
npm install pdfkit
```

---

## 📊 Supported File Formats

| Format | Extension | Support |
|--------|-----------|---------|
| PDF | .pdf | ✅ Full support |
| Word (2007+) | .docx | ✅ Full support |
| Word (97-2003) | .doc | ✅ Basic support |
| Text | .txt | ✅ Full support |

---

## 🚀 Advanced Usage

### Enable Debug Mode
In `.env` file:
```
NODE_ENV=development
DEBUG=*
```

### Change Server Port
In `.env` file:
```
PORT=8000
```

### Run with Nodemon (Auto-restart on changes)
```bash
npm run dev
```

---

## 📞 Support

If you encounter issues:

1. Check if Node.js is installed: `node --version`
2. Check if npm packages are installed: `npm list`
3. Check if backend is running: Visit `http://localhost:3000/api/health`
4. Check browser console for errors: Press F12
5. Check terminal for error messages

---

## 🎉 You're All Set!

Your Gulf CV Expert backend is now running! 

- **Frontend**: http://localhost:3000
- **API Base**: http://localhost:3000/api
- **Health Check**: http://localhost:3000/api/health

Users can now:
✅ Upload CVs in multiple formats
✅ Convert to ATS format
✅ Download as professional PDF
✅ Build new CVs step-by-step
✅ Choose from 3 templates

---

## 📝 Notes

- Files are stored temporarily and deleted after download
- PDFs are generated server-side for better quality
- Frontend API calls expect backend to be running
- All uploaded files are validated for security
- Maximum file size: 5MB

Happy CV building! 🚀
