import { RequestTransformError } from "./errors.js";

export const KIRO_DOCUMENT_FORMATS = [
  "csv",
  "doc",
  "docx",
  "html",
  "md",
  "pdf",
  "txt",
  "xls",
  "xlsx",
] as const;

export type KiroDocumentFormat = (typeof KIRO_DOCUMENT_FORMATS)[number];

const DOCUMENT_FORMAT_SET = new Set<string>(KIRO_DOCUMENT_FORMATS);

const MEDIA_TYPE_FORMATS: Readonly<Record<string, KiroDocumentFormat>> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
};

export interface InlineDocument {
  readonly name: string;
  readonly format: KiroDocumentFormat;
  readonly data: string;
  readonly path: string;
}

export interface KiroDocument {
  readonly name: string;
  readonly format: KiroDocumentFormat;
  readonly source: { readonly bytes: Uint8Array };
}

function isKiroDocumentNameCharacter(character: string): boolean {
  return (
    character === " " ||
    character === "-" ||
    character === "_" ||
    character === "(" ||
    character === ")" ||
    character === "[" ||
    character === "]" ||
    /[A-Za-z0-9]/.test(character)
  );
}

function kiroDocumentName(filename: string, format: KiroDocumentFormat, path: string): string {
  const suffix = `.${format}`;
  const name = filename.toLowerCase().endsWith(suffix)
    ? filename.slice(0, -suffix.length)
    : filename;
  const length = Array.from(name).length;
  if (
    length < 1 ||
    length > 200 ||
    name.startsWith(" ") ||
    name.endsWith(" ") ||
    name.includes("  ") ||
    Array.from(name).some((character) => !isKiroDocumentNameCharacter(character))
  ) {
    throw new RequestTransformError(
      `Inline document ${path} cannot be represented by Kiro's native document name field`,
      "invalid_file_name",
      path,
    );
  }
  return name;
}

function extensionFormat(filename: string): KiroDocumentFormat | undefined {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  return extension !== undefined && DOCUMENT_FORMAT_SET.has(extension)
    ? (extension as KiroDocumentFormat)
    : undefined;
}

function dataUrlParts(value: string): {
  readonly mediaType?: string;
  readonly base64: string;
} {
  if (!value.startsWith("data:")) return { base64: value };
  const comma = value.indexOf(",");
  if (comma < 0) {
    throw new RequestTransformError(
      "Inline document data URL is missing its payload",
      "invalid_file_data",
    );
  }
  const header = value.slice(5, comma);
  const segments = header.split(";");
  if (!segments.includes("base64")) {
    throw new RequestTransformError(
      "Inline document data URLs must use base64 encoding",
      "unsupported_file_encoding",
    );
  }
  return {
    ...(segments[0] ? { mediaType: segments[0].toLowerCase() } : {}),
    base64: value.slice(comma + 1),
  };
}

function decodeBase64(value: string, path: string): Uint8Array {
  if (value.length === 0) {
    throw new RequestTransformError(
      `Inline document ${path} contains no data`,
      "invalid_file_data",
      path,
    );
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    throw new RequestTransformError(
      `Inline document ${path} contains invalid base64 data`,
      "invalid_file_data",
      path,
    );
  }
}

export function resolveInlineDocument(
  filename: string,
  fileData: string,
  path: string,
  filenamePath = path,
): InlineDocument {
  const data = dataUrlParts(fileData);
  const format =
    extensionFormat(filename) ??
    (data.mediaType === undefined ? undefined : MEDIA_TYPE_FORMATS[data.mediaType]);
  if (format === undefined) {
    throw new RequestTransformError(
      `Inline document ${path} has an unsupported file format`,
      "unsupported_file_format",
      path,
    );
  }
  kiroDocumentName(filename, format, filenamePath);
  decodeBase64(data.base64, path);
  return { name: filename, format, data: data.base64, path };
}

export function toKiroDocument(document: InlineDocument): KiroDocument {
  return {
    name: kiroDocumentName(document.name, document.format, document.path),
    format: document.format,
    source: { bytes: decodeBase64(document.data, document.path) },
  };
}
