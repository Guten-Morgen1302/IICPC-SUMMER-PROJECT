import * as zlib from 'zlib';
import * as path from 'path';

/**
 * Validates whether a buffer is a valid ZIP or TAR (.tar or .tar.gz) archive
 * and contains a Dockerfile.
 * 
 * Implemented in pure TypeScript to ensure 100% reliability without external dependencies.
 */
export interface ValidationResult {
  isValid: boolean;
  error?: string;
  filesFound?: string[];
}

/**
 * Check if the buffer has the Gzip magic header.
 */
function isGzip(buffer: Buffer): boolean {
  return buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/**
 * Check if the buffer has the ZIP local file header signature (PK\x03\x04).
 */
function isZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

/**
 * Parse file names from a ZIP buffer using the Central Directory (CD).
 * This is robust and handles data descriptors and all compression types.
 */
function parseZipFiles(buffer: Buffer): string[] {
  const files: string[] = [];
  
  // Find End of Central Directory (EOCD) signature: 0x06054b50 (PK\x05\x06)
  let eocdOffset = -1;
  // Scan from the end of the file. EOCD is at least 22 bytes long.
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 65557; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP file: End of Central Directory (EOCD) not found.');
  }

  let cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);

  // Fallback adjustment for prepended headers / self-extracting zip
  if (cdOffset + cdSize > eocdOffset) {
    cdOffset = eocdOffset - cdSize;
  }

  let currentOffset = cdOffset;
  for (let entry = 0; entry < totalEntries; entry++) {
    if (currentOffset + 46 > buffer.length) break;
    
    // Central Directory File Header (CDFH) signature: 0x02014b50 (PK\x01\x02)
    const sig = buffer.readUInt32LE(currentOffset);
    if (sig !== 0x02014b50) break;

    const fileNameLength = buffer.readUInt16LE(currentOffset + 28);
    const extraFieldLength = buffer.readUInt16LE(currentOffset + 30);
    const fileCommentLength = buffer.readUInt16LE(currentOffset + 32);

    if (currentOffset + 46 + fileNameLength > buffer.length) break;
    const fileName = buffer.toString('utf8', currentOffset + 46, currentOffset + 46 + fileNameLength);
    files.push(fileName);

    currentOffset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  return files;
}

/**
 * Parse file names from a TAR buffer using 512-byte blocks.
 */
function parseTarFiles(buffer: Buffer): string[] {
  const files: string[] = [];
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    // A block of 512 zeroes indicates the end of the archive
    let isNullBlock = true;
    for (let i = 0; i < 512; i++) {
      if (buffer[offset + i] !== 0) {
        isNullBlock = false;
        break;
      }
    }
    if (isNullBlock) break;

    // File name is in the first 100 bytes (null-terminated)
    let name = buffer.toString('utf8', offset, offset + 100).replace(/\0/g, '').trim();
    if (!name) {
      offset += 512;
      continue;
    }

    // Check for USTAR prefix
    const ustar = buffer.toString('utf8', offset + 257, offset + 263);
    if (ustar.startsWith('ustar')) {
      const prefix = buffer.toString('utf8', offset + 345, offset + 345 + 155).replace(/\0/g, '').trim();
      if (prefix) {
        name = prefix + '/' + name;
      }
    }

    // File size is octal at offset 124, 12 bytes
    const sizeStr = buffer.toString('utf8', offset + 124, offset + 124 + 12).replace(/\0/g, '').trim();
    const size = parseInt(sizeStr, 8);

    if (isNaN(size)) {
      // Corrupt or invalid TAR block size
      throw new Error('Invalid TAR file: corrupt size field.');
    }

    files.push(name);

    // Skip to next header: 512 bytes header + data blocks rounded to 512
    const dataBlocks = Math.ceil(size / 512);
    offset += 512 + dataBlocks * 512;
  }

  return files;
}

/**
 * Validates submission archive and searches for a Dockerfile.
 */
export function validateArchive(buffer: Buffer): ValidationResult {
  if (!buffer || buffer.length === 0) {
    return { isValid: false, error: 'Archive is empty' };
  }

  // 1. Check size (50MB cap)
  const MAX_SIZE = 50 * 1024 * 1024;
  if (buffer.length > MAX_SIZE) {
    return { isValid: false, error: 'Archive size exceeds the 50MB limit' };
  }

  let archiveBuffer = buffer;
  let isTarGz = false;

  // 2. Handle gzip decompression if necessary
  if (isGzip(buffer)) {
    try {
      archiveBuffer = zlib.gunzipSync(buffer);
      isTarGz = true;
    } catch (err: any) {
      return { isValid: false, error: `Failed to decompress gzip archive: ${err.message}` };
    }
  }

  let files: string[] = [];

  // 3. Parse archive contents based on type
  if (isZip(archiveBuffer)) {
    if (isTarGz) {
      return { isValid: false, error: 'Malformed archive: gzipped file is a ZIP, expected TAR' };
    }
    try {
      files = parseZipFiles(archiveBuffer);
    } catch (err: any) {
      return { isValid: false, error: `Failed to parse ZIP archive: ${err.message}` };
    }
  } else {
    // If not ZIP, check if it's TAR.
    // Standard TAR files have "ustar" at offset 257 in the first block, or we can just attempt to parse.
    try {
      files = parseTarFiles(archiveBuffer);
    } catch (err: any) {
      return { isValid: false, error: `Failed to parse TAR archive: ${err.message}` };
    }
  }

  if (files.length === 0) {
    return { isValid: false, error: 'Archive contains no files' };
  }

  // 4. Verify presence of Dockerfile
  const hasDockerfile = files.some(file => {
    // Exclude directory entries
    if (file.endsWith('/') || file.endsWith('\\')) {
      return false;
    }
    
    // Normalize path separators to forward slash
    const normalized = file.replace(/\\/g, '/');
    const base = path.basename(normalized);
    
    return base === 'Dockerfile';
  });

  if (!hasDockerfile) {
    return { 
      isValid: false, 
      error: 'Archive must contain a Dockerfile',
      filesFound: files.slice(0, 50) // Return first 50 files for debugging
    };
  }

  return { isValid: true, filesFound: files };
}
