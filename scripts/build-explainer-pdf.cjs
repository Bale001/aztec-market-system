// Renders docs/how-it-works.html to docs/Aztec-Market-System-Explained.pdf.
//
//   node scripts/build-explainer-pdf.cjs
//
// Uses Electron's Chromium, which the desktop app already depends on, so this
// needs no extra toolchain: the document is print-styled (@page A4, page-break
// rules) and Chromium is what those rules were written for.
//
// KNOWN TO FAIL UNDER WSL. Chromium's shared-memory allocation there dies with
// a nonsensical "No such process" against /dev/shm AND /tmp, even when both are
// 1777 and have gigabytes free, and --disable-dev-shm-usage does not help. If
// that happens, render from the Windows side instead -- the file is reachable
// over the UNC path and Edge is already Chromium:
//
//   & "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" `
//       --headless --disable-gpu --no-pdf-header-footer `
//       "--print-to-pdf=$env:TEMP\\explainer.pdf" `
//       "file:////wsl.localhost/Ubuntu/home/<user>/aztec-market-system/docs/how-it-works.html"
//
// then copy the result over docs/Aztec-Market-System-Explained.pdf.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'docs', 'how-it-works.html');
const OUTPUT = path.join(ROOT, 'docs', 'Aztec-Market-System-Explained.pdf');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  await win.loadFile(SOURCE);
  // Give fonts and layout a moment to settle before capture.
  await new Promise(resolve => setTimeout(resolve, 500));

  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    // The stylesheet owns the margins (@page { margin: 22mm 19mm }), so do not
    // let Chromium add its own on top.
    margins: { marginType: 'none' },
    preferCSSPageSize: true,
  });

  fs.writeFileSync(OUTPUT, pdf);
  console.log(`wrote ${path.relative(ROOT, OUTPUT)} (${(pdf.length / 1024).toFixed(0)} KB)`);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
