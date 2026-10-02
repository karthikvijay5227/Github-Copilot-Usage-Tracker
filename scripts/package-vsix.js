// // Packages the extension without requiring the vsce CLI.
// const fs = require('fs');
// const path = require('path');
// const cp = require('child_process');
// const root = path.resolve(__dirname, '..');
// const out = path.join(root, 'copilot-usage-monitor-0.2.0.vsix');
// try { fs.unlinkSync(out); } catch (_) {}
// const manifest = `<?xml version="1.0" encoding="utf-8"?>\n<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">\n  <Metadata>\n    <Identity Language="en-US" Id="copilot-usage-monitor" Version="0.2.0" Publisher="local" />\n    <DisplayName>Copilot Enterprise Credit Tracker</DisplayName>\n    <Description xml:space="preserve">Tracks GitHub Copilot Enterprise AI-credit usage over time.</Description>\n  </Metadata>\n  <Installation InstalledByMsi="false"><InstallationTarget Id="Microsoft.VisualStudio.Code" Version="^1.96.0" /></Installation>\n  <Dependencies />\n  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" /><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" /></Assets>\n</PackageManifest>`;
// const tmp = path.join(root, '.vsix-tmp');
// fs.rmSync(tmp, { recursive: true, force: true });
// fs.mkdirSync(path.join(tmp, 'extension'), { recursive: true });
// for (const name of ['package.json','extension.js','README.md','.vscodeignore']) fs.copyFileSync(path.join(root,name), path.join(tmp,'extension',name));
// fs.writeFileSync(path.join(tmp,'extension.vsixmanifest'), manifest);
// // Use the system zip command; VSIX is a ZIP package with a manifest and extension directory.
// cp.execFileSync('zip', ['-qr', out, 'extension.vsixmanifest', 'extension'], { cwd: tmp });
// fs.rmSync(tmp, { recursive: true, force: true });
// console.log(out);

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "copilot-usage-monitor-0.2.0.vsix");

/**
 * Recursively lists files under a directory, returning paths relative to `root`
 * using forward slashes.
 *
 * @param {string} dir - Absolute directory to walk.
 * @param {string} root - Absolute root used to compute relative paths.
 * @returns {string[]} Relative file paths.
 */
function listFilesRecursive(dir, root) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, root));
    else out.push(path.relative(root, full).replace(/\\/g, "/"));
  }
  return out;
}

const srcFiles = listFilesRecursive(path.join(root, "src"), root).map(
  (p) => `extension/${p}`,
);

const files = [
  "extension.vsixmanifest",
  "[Content_Types].xml",
  "extension/package.json",
  "extension/extension.js",
  "extension/README.md",
  "extension/.vscodeignore",
  ...srcFiles,
];

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="copilot-usage-monitor" Version="0.2.0" Publisher="local" />
    <DisplayName>Copilot Enterprise Credit Tracker</DisplayName>
    <Description xml:space="preserve">Tracks GitHub Copilot Enterprise AI-credit usage over time.</Description>
  </Metadata>
  <Installation InstalledByMsi="false">
    <InstallationTarget Id="Microsoft.VisualStudio.Code" Version="^1.96.0" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" />
  </Assets>
</PackageManifest>`;

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="vscodeignore" ContentType="text/plain" />
</Types>`;

// -----------------------------------------------------------------------------
// Minimal ZIP writer using Node.js only.
// Uses ZIP "store" mode (no compression), which is perfectly valid for VSIX.
// -----------------------------------------------------------------------------

function crc32(buffer) {
  let crc = 0xffffffff;

  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];

    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value, 0);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());

  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),

    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];

  let offset = 0;

  const dt = dosDateTime();

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data);

    const crc = crc32(data);

    // Local file header
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0), // STORE
      u16(dt.time),
      u16(dt.date),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
    ]);

    localParts.push(localHeader, data);

    // Central directory header
    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(dt.time),
      u16(dt.date),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);

    centralParts.push(centralHeader);

    offset += localHeader.length + data.length;
  }

  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);

  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);

  return Buffer.concat([local, central, end]);
}

// -----------------------------------------------------------------------------
// Build temporary extension directory
// -----------------------------------------------------------------------------

const temp = path.join(root, ".vsix-tmp");

fs.rmSync(temp, {
  recursive: true,
  force: true,
});

fs.mkdirSync(path.join(temp, "extension"), {
  recursive: true,
});

fs.writeFileSync(path.join(temp, "extension.vsixmanifest"), manifest, "utf8");

fs.writeFileSync(path.join(temp, "[Content_Types].xml"), contentTypes, "utf8");

for (const file of [
  "package.json",
  "extension.js",
  "README.md",
  ".vscodeignore",
]) {
  fs.copyFileSync(path.join(root, file), path.join(temp, "extension", file));
}

for (const relativeSrcFile of srcFiles.map((p) =>
  p.replace(/^extension\//, ""),
)) {
  const dest = path.join(temp, "extension", relativeSrcFile);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, relativeSrcFile), dest);
}

// -----------------------------------------------------------------------------
// Create VSIX
// -----------------------------------------------------------------------------

const entries = [];

for (const file of files) {
  const filePath = path.join(temp, file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required file: ${file}`);
  }

  entries.push({
    name: file.replace(/\\/g, "/"),
    data: fs.readFileSync(filePath),
  });
}

const zip = createZip(entries);

fs.writeFileSync(output, zip);

fs.rmSync(temp, {
  recursive: true,
  force: true,
});

console.log("");
console.log("VSIX created successfully:");
console.log(output);
console.log("");
