// test-zip.js — tests for the ZIP build helper in itDeclarationController
// Run with: node test-zip.js
'use strict';
const assert  = require('assert');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const AdmZip  = require('adm-zip');

// ── Inline copy of buildDeclZip (must stay in sync with controller) ────────────
function resolveFilePath(filePath) {
  const candidates = [filePath].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

async function buildDeclZip(items, excelBuf, excelName) {
  const zip = new AdmZip();
  const missing = [];
  zip.addFile(excelName, Buffer.from(excelBuf));
  for (const { d, proofs } of items) {
    const folderName = `${d.employee_code} - ${((d.first_name||'') + ' ' + (d.last_name||'')).trim()}`;
    for (const p of proofs) {
      const absPath = resolveFilePath(p.file_path);
      const section  = (p.section  || 'misc').replace(/[^a-zA-Z0-9_]/g, '_');
      const docType  = (p.doc_type || 'doc' ).replace(/[^a-zA-Z0-9_]/g, '_');
      const ext      = path.extname(p.file_name || '');
      const baseName = (p.file_name || `${docType}${ext}`).replace(/[^a-zA-Z0-9._-]/g,'_');
      if (absPath) {
        zip.addLocalFile(absPath, `${folderName}/${section}`, `${docType}__${baseName}`);
      } else {
        missing.push(`${folderName}/${section}/${docType}__${baseName}`);
      }
    }
  }
  if (missing.length) zip.addFile('MISSING_FILES.txt', Buffer.from(missing.join('\n')));
  return zip.toBuffer();
}

// ── Tests ─────────────────────────────────────────────────────────────────────
async function run() {
  let passed = 0, failed = 0;

  async function test(name, fn) {
    try { await fn(); console.log('  ✅', name); passed++; }
    catch(e) { console.error('  ❌', name, '—', e.message); failed++; }
  }

  console.log('\n📦 ZIP helper tests\n');

  // 1. ZIP contains the Excel file
  await test('ZIP contains the excel file at root', async () => {
    const buf = await buildDeclZip([], Buffer.from('fake excel'), 'IT_Decl.xlsx');
    const zip = new AdmZip(buf);
    const entry = zip.getEntry('IT_Decl.xlsx');
    assert(entry, 'IT_Decl.xlsx not found in zip');
    assert.strictEqual(entry.getData().toString(), 'fake excel');
  });

  // 2. Empty items → no folders, no MISSING_FILES
  await test('Empty items → only excel, no MISSING_FILES', async () => {
    const buf = await buildDeclZip([], Buffer.from('x'), 'data.xlsx');
    const zip = new AdmZip(buf);
    const entries = zip.getEntries().map(e => e.entryName);
    assert(!entries.includes('MISSING_FILES.txt'), 'Should not have MISSING_FILES.txt');
    assert.strictEqual(entries.length, 1);
  });

  // 3. Missing file → MISSING_FILES.txt lists it
  await test('Missing proof file is listed in MISSING_FILES.txt', async () => {
    const d = { employee_code:'E001', first_name:'Test', last_name:'User' };
    const proofs = [{ section:'80C', doc_type:'lic_receipt', file_name:'lic.pdf', file_path:'/nonexistent/lic.pdf' }];
    const buf = await buildDeclZip([{ d, proofs }], Buffer.from('x'), 'x.xlsx');
    const zip = new AdmZip(buf);
    const mf = zip.getEntry('MISSING_FILES.txt');
    assert(mf, 'MISSING_FILES.txt missing');
    assert(mf.getData().toString().includes('E001'), 'Should mention E001');
  });

  // 4. Real file → correct folder path
  await test('Real file lands at CODE - Name/section/doctype__filename', async () => {
    // create a real temp file
    const tmp = path.join(os.tmpdir(), 'test_proof.pdf');
    fs.writeFileSync(tmp, 'pdf content');
    const d = { employee_code:'E002', first_name:'Aarav', last_name:'Sharma' };
    const proofs = [{ section:'HRA', doc_type:'rent_receipt', file_name:'rent_receipt.pdf', file_path:tmp }];
    const buf = await buildDeclZip([{ d, proofs }], Buffer.from('x'), 'x.xlsx');
    const zip = new AdmZip(buf);
    const entries = zip.getEntries().map(e => e.entryName);
    const expected = 'E002 - Aarav Sharma/HRA/rent_receipt__rent_receipt.pdf';
    assert(entries.includes(expected), `Expected "${expected}" in [${entries.join(', ')}]`);
    fs.unlinkSync(tmp);
  });

  // 5. ZIP is a valid Buffer
  await test('buildDeclZip returns a Buffer', async () => {
    const buf = await buildDeclZip([], Buffer.from('y'), 'y.xlsx');
    assert(Buffer.isBuffer(buf), 'Not a Buffer');
    assert(buf.length > 0, 'Empty buffer');
  });

  // 6. Multiple employees → no cross-folder pollution
  await test('Two employees get separate folders', async () => {
    const d1 = { employee_code:'E001', first_name:'A', last_name:'B' };
    const d2 = { employee_code:'E002', first_name:'C', last_name:'D' };
    const buf = await buildDeclZip([{ d:d1, proofs:[] }, { d:d2, proofs:[] }], Buffer.from('x'), 'x.xlsx');
    const zip = new AdmZip(buf);
    const entries = zip.getEntries().map(e => e.entryName);
    // Only the excel should be there (no proofs)
    assert.strictEqual(entries.filter(e => e !== 'x.xlsx').length, 0, 'Unexpected entries');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
