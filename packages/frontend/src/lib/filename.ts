const KNOWN_DOC_EXT = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx']);

export function displayFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return filename;
  const ext = filename.slice(dot + 1).toLowerCase();
  return KNOWN_DOC_EXT.has(ext) ? filename.slice(0, dot) : filename;
}

export function extensionLabel(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return 'DOC';
  const ext = filename.slice(dot + 1).toUpperCase();
  return ext.length <= 5 ? ext : 'DOC';
}

export function prettyBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} TiB`;
}
