import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const OUTPUT_DIR = path.join(__dirname, 'downloaded_pdfs');
const CSV_FILE = path.join(__dirname, 'data.csv');

// Create axios instance with headers
const axiosInstance = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  },
  validateStatus: () => true
});

let downloadedCount = 0;
let failedUrls = [];

// Logger helper
const log = (message, type = 'info') => {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = {
    info: '[INFO]',
    success: '[✓]',
    error: '[✗]',
    warning: '[!]'
  }[type] || '[LOG]';
  console.log(`${timestamp} ${prefix} ${message}`);
};

// Download PDF file
async function downloadPdf(url, filename) {
  try {
    log(`Downloading: ${url}`);
    const response = await axiosInstance.get(url, { responseType: 'arraybuffer' });
    
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    let filepath = path.join(OUTPUT_DIR, filename);
    
    // Avoid duplicates
    if (fs.existsSync(filepath)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      let counter = 1;
      while (fs.existsSync(path.join(OUTPUT_DIR, `${base}_${counter}${ext}`))) {
        counter++;
      }
      filepath = path.join(OUTPUT_DIR, `${base}_${counter}${ext}`);
    }

    await fs.writeFile(filepath, response.data);
    log(`Berhasil download: ${path.basename(filepath)}`, 'success');
    downloadedCount++;
    return true;
  } catch (error) {
    log(`Gagal download ${url}: ${error.message}`, 'error');
    failedUrls.push(url);
    return false;
  }
}

// Find PDFs in HTML page
async function findPdfsInPage(url) {
  const pdfUrls = [];
  try {
    log(`Crawling halaman: ${url}`);
    const response = await axiosInstance.get(url);
    
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    const $ = cheerio.load(response.data);
    
    // Find all links with PDF
    $('a[href]').each((index, element) => {
      const href = $(element).attr('href');
      if (href && href.toLowerCase().endsWith('.pdf')) {
        try {
          const fullUrl = new URL(href, url).href;
          pdfUrls.push(fullUrl);
        } catch (e) {
          // Skip invalid URLs
        }
      }
    });

    log(`Ditemukan ${pdfUrls.length} PDF links`);
    return pdfUrls;
  } catch (error) {
    log(`Error crawling ${url}: ${error.message}`, 'error');
    return [];
  }
}

// Parse CSV file - simple parser
function parseCSV(content) {
  const lines = content.split('\n');
  const rows = [];
  const headers = parseCSVLine(lines[0]);
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    rows.push(row);
  }
  
  return rows;
}

// Parse a single CSV line
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let insideQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

// Safe filename
function sanitizeFilename(str) {
  return str.replace(/[/\\?%*:|"<>]/g, '_');
}

// Process CSV file
async function processCSVFile(csvPath, startRowNumber) {
  if (!fs.existsSync(csvPath)) {
    log(`File CSV tidak ditemukan: ${csvPath}`, 'error');
    return 0;
  }

  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  const rows = parseCSV(csvContent);
  log(`Processing: ${path.basename(csvPath)} - Total baris: ${rows.length}`);

  let processedCount = 0;

  // Process each row
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const url = row['Tautan Sumber'];
    const namaEntitas = row['Nama Entitas/Produk'];
    const jenisDokumen = row['Jenis Dokumen'];
    const rowNumber = startRowNumber + idx;

    log(`\n[${rowNumber}] Processing: ${namaEntitas}`);

    if (!url || url.trim() === '') {
      log('URL kosong, skip', 'warning');
      continue;
    }

    const safeName = sanitizeFilename(
      `${String(rowNumber).padStart(3, '0')}_${namaEntitas}_${jenisDokumen}`
    );

    if (url.toLowerCase().endsWith('.pdf')) {
      // Direct PDF URL
      const filename = `${safeName}.pdf`;
      await downloadPdf(url, filename);
    } else {
      // HTML page, find PDFs in it
      const pdfLinks = await findPdfsInPage(url);
      if (pdfLinks.length > 0) {
        for (let i = 0; i < pdfLinks.length; i++) {
          const filename = pdfLinks.length > 1 
            ? `${safeName}_${i + 1}.pdf` 
            : `${safeName}.pdf`;
          await downloadPdf(pdfLinks[i], filename);
        }
      } else {
        log(`Tidak ada PDF ditemukan di ${url}`, 'warning');
      }
    }

    processedCount++;

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return processedCount;
}

// Main function
async function main() {
  try {
    log('Memulai crawler PDF...');
    
    // Create output directory
    await fs.ensureDir(OUTPUT_DIR);

    // Process data.csv
    log('\n' + '='.repeat(50));
    log('Processing data.csv', 'info');
    log('='.repeat(50));
    await processCSVFile(CSV_FILE, 1);

    // Process data1.csv
    const csv1File = path.join(__dirname, 'data1.csv');
    log('\n' + '='.repeat(50));
    log('Processing data1.csv', 'info');
    log('='.repeat(50));
    await processCSVFile(csv1File, 51);

    // Summary
    log('\n' + '='.repeat(50));
    log('SELESAI!', 'success');
    log(`Total PDF berhasil didownload: ${downloadedCount}`, 'success');
    log(`Output directory: ${OUTPUT_DIR}`, 'info');

    if (failedUrls.length > 0) {
      log(`\nURL yang gagal (${failedUrls.length}):`, 'warning');
      failedUrls.forEach(url => {
        log(`  - ${url}`, 'warning');
      });
    }
    log('='.repeat(50));

  } catch (error) {
    log(`Fatal error: ${error.message}`, 'error');
    console.error(error);
    process.exit(1);
  }
}

// Run
main();
