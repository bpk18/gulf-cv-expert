@echo off
echo.
echo ╔═════════════════════════════════════════╗
echo ║  Gulf CV Expert - Quick Start Setup    ║
echo ╚═════════════════════════════════════════╝
echo.

echo [Step 1/3] Installing dependencies...
echo Please wait, this may take a few minutes...
call npm install

if %errorlevel% neq 0 (
    echo.
    echo ❌ npm install failed
    echo Please make sure Node.js is installed
    echo Download from: https://nodejs.org
    pause
    exit /b 1
)

echo.
echo ✓ Dependencies installed successfully

echo.
echo [Step 2/3] Creating .env file...
if not exist .env (
    (
        echo PORT=3000
        echo NODE_ENV=development
    ) > .env
    echo ✓ .env file created
) else (
    echo ✓ .env file already exists
)

echo.
echo [Step 3/3] Creating directories...
if not exist uploads mkdir uploads
if not exist generated-pdfs mkdir generated-pdfs
echo ✓ Directories created

echo.
echo ╔═════════════════════════════════════════╗
echo ║  Setup Complete! Ready to Start        ║
echo ╠═════════════════════════════════════════╣
echo ║                                         ║
echo ║  To start the server, run:              ║
echo ║                                         ║
echo ║    npm start                            ║
echo ║                                         ║
echo ║  Server will run on:                    ║
echo ║    http://localhost:3000                ║
echo ║                                         ║
echo ╚═════════════════════════════════════════╝
echo.
pause
