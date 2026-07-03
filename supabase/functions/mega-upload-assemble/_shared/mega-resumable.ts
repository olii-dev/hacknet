import { createCipheriv, randomBytes } from 'node:crypto';

const INITIAL_CHUNK_SIZE = 128 * 1024;
const CHUNK_SIZE_INCREMENT = 128 * 1024;
const MAX_CHUNK_SIZE = 1024 * 1024;

export type MacState = {
  pos: number;
  posNext: number;
  increment: number;
  macs: string[];
  mac: string | null;
};

export type UploadTransferState = {
  bytesUploaded: number;
  currentChunkSize: number;
  remainingBufferB64: string | null;
  totalCiphertextSize: number;
};

export type AssembleMegaState = {
  uploadUrl: string;
  fileKeyB64: string;
  transfer: UploadTransferState;
  mac: MacState;
  uploadHashB64: string | null;
  folderNodeId: string;
};

type MegaApi = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  request: (req: Record<string, unknown>, cb: (err: Error | null, resp?: unknown) => void) => void;
};

type MegaStorage = {
  api: MegaApi;
  aes: { encryptECB: (buf: Uint8Array) => Uint8Array };
  files: Record<string, MegaFolder>;
  shareKeys: Record<string, Uint8Array>;
  _importFile: (node: Record<string, unknown>) => MegaUploadedFile;
};

export type MegaFolder = {
  nodeId: string;
  directory: boolean;
  children?: unknown[];
  name: string;
};

export type MegaUploadedFile = {
  link: (o?: object) => Promise<string>;
  nodeId?: string;
  id?: string;
};

function b64(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf));
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function pad16(data: Uint8Array): Uint8Array {
  const rest = Math.ceil(data.length / 16) * 16 - data.length;
  if (rest === 0) return data;
  const out = new Uint8Array(data.length + rest);
  out.set(data);
  return out;
}

function incrementCtrBuffer(buf: Uint8Array, cnt: number) {
  let i = buf.length - 1;
  while (cnt !== 0) {
    const mod = (cnt + buf[i]) % 256;
    cnt = Math.floor((cnt + buf[i]) / 256);
    buf[i] = mod;
    i -= 1;
    if (i < 0) i = buf.length - 1;
  }
}

class Aes128 {
  key: Uint8Array;
  constructor(key: Uint8Array) {
    this.key = key.slice(0, 16);
  }
  encryptEcb(buffer: Uint8Array): Uint8Array {
    const cipher = createCipheriv('aes-128-ecb', this.key, Buffer.alloc(0));
    cipher.setAutoPadding(false);
    return new Uint8Array(cipher.update(buffer));
  }
}

class Ctr {
  private key: Uint8Array;
  private iv: Buffer;
  private cipher: ReturnType<typeof createCipheriv> | null = null;

  constructor(key: Uint8Array, nonce: Uint8Array, start = 0) {
    this.key = key;
    this.iv = Buffer.alloc(16);
    nonce.slice(0, 8).forEach((b, i) => { this.iv[i] = b; });
    if (start !== 0) incrementCtrBuffer(this.iv, start / 16);
  }

  encrypt(buffer: Uint8Array): Uint8Array {
    if (!this.cipher) {
      this.cipher = createCipheriv('aes-128-ctr', this.key, this.iv);
    }
    const out = new Uint8Array(buffer.length);
    out.set(this.cipher!.update(buffer));
    return out;
  }
}

class Mac {
  pos = 0;
  posNext: number;
  increment: number;
  macs: Uint8Array[] = [];
  mac: Uint8Array;

  constructor(private aes: Aes128, nonce: Uint8Array) {
    this.posNext = this.increment = 131072;
    this.mac = Buffer.alloc(16);
    nonce.slice(0, 8).forEach((b, i) => { this.mac[i] = b; this.mac[i + 8] = b; });
  }

  static fromState(aes: Aes128, nonce: Uint8Array, state: MacState): Mac {
    const mac = new Mac(aes, nonce);
    mac.pos = state.pos;
    mac.posNext = state.posNext;
    mac.increment = state.increment;
    mac.macs = state.macs.map((s) => fromB64(s));
    mac.mac = state.mac ? fromB64(state.mac) : Buffer.alloc(16);
    return mac;
  }

  toState(): MacState {
    return {
      pos: this.pos,
      posNext: this.posNext,
      increment: this.increment,
      macs: this.macs.map((m) => b64(m)),
      mac: this.mac ? b64(this.mac) : null,
    };
  }

  update(buffer: Uint8Array) {
    for (let i = 0; i < buffer.length; i += 16) {
      for (let j = 0; j < 16; j++) this.mac[j] ^= buffer[i + j];
      this.mac = new Uint8Array(this.aes.encryptEcb(this.mac));
      this.checkBounding();
    }
  }

  private checkBounding() {
    this.pos += 16;
    if (this.pos >= this.posNext) {
      this.macs.push(Uint8Array.from(this.mac));
      const nonce8 = this.mac.slice(0, 8);
      this.mac = Buffer.alloc(16);
      this.mac.set(nonce8, 0);
      this.mac.set(nonce8, 8);
      if (this.increment < 1048576) this.increment += 131072;
      this.posNext += this.increment;
    }
  }

  condense(): Uint8Array {
    if (this.mac) {
      this.macs.push(Uint8Array.from(this.mac));
    }
    let mac = Buffer.alloc(16, 0);
    for (const item of this.macs) {
      for (let j = 0; j < 16; j++) mac[j] ^= item[j];
      mac = Buffer.from(this.aes.encryptEcb(mac));
    }
    const macBuffer = Buffer.allocUnsafe(8);
    macBuffer.writeInt32BE(mac.readInt32BE(0) ^ mac.readInt32BE(4), 0);
    macBuffer.writeInt32BE(mac.readInt32BE(8) ^ mac.readInt32BE(12), 4);
    return new Uint8Array(macBuffer);
  }
}

function mergeKeyMac(key: Uint8Array, mac: Uint8Array): Uint8Array {
  const newKey = Buffer.alloc(32);
  newKey.set(key.slice(0, 24));
  newKey.set(mac, 24);
  for (let i = 0; i < 16; i++) {
    newKey[i] = newKey[i] ^ newKey[16 + i];
  }
  return new Uint8Array(newKey);
}

function packAttributes(attributes: Record<string, string>): Uint8Array {
  const json = `MEGA${JSON.stringify(attributes)}`;
  const at = Buffer.from(json);
  const ret = Buffer.alloc(Math.ceil(at.length / 16) * 16);
  at.copy(ret);
  return new Uint8Array(ret);
}

function e64(buffer: Uint8Array): string {
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function paddedCiphertextSize(sizeBytes: number): number {
  return Math.ceil(sizeBytes / 16) * 16;
}

export function encryptStagingBytes(
  fileKey: Uint8Array,
  macState: MacState,
  plaintext: Uint8Array,
  plaintextOffset: number,
  padTo16: boolean,
): { ciphertext: Uint8Array; mac: MacState } {
  const data = padTo16 ? pad16(plaintext) : plaintext;
  const aes = new Aes128(fileKey.slice(0, 16));
  const ctr = new Ctr(aes.key, fileKey.slice(16), plaintextOffset);
  const mac = Mac.fromState(aes, fileKey.slice(16), macState);

  const ciphertext = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) {
    const block = data.slice(i, i + 16);
    mac.update(block);
    const enc = ctr.encrypt(block);
    ciphertext.set(enc, i);
  }
  return { ciphertext, mac: mac.toState() };
}

function requestUploadUrl(api: MegaApi, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    api.request({ a: 'u', ssl: 2, s: size, ms: 0, r: 0, e: 0, v: 2 }, (err, resp) => {
      if (err) return reject(err);
      const url = (resp as { p?: string })?.p;
      if (!url) return reject(new Error('Mega did not return an upload URL.'));
      resolve(url);
    });
  });
}

async function postChunk(
  api: MegaApi,
  uploadUrl: string,
  position: number,
  body: Uint8Array,
): Promise<Uint8Array> {
  const response = await api.fetch(`${uploadUrl}/${position}`, {
    method: 'POST',
    body,
    headers: { 'content-length': String(body.length) },
  });
  if (!response.ok) throw new Error(`Mega upload returned HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function initMegaUploadState(
  storage: MegaStorage,
  folder: MegaFolder,
  sizeBytes: number,
): Promise<AssembleMegaState> {
  const fileKey = randomBytes(24);
  const paddedSize = paddedCiphertextSize(sizeBytes);
  const uploadUrl = await requestUploadUrl(storage.api, paddedSize);
  const mac = new Mac(new Aes128(fileKey.slice(0, 16)), fileKey.slice(16)).toState();
  return {
    uploadUrl,
    fileKeyB64: b64(fileKey),
    transfer: {
      bytesUploaded: 0,
      currentChunkSize: INITIAL_CHUNK_SIZE,
      remainingBufferB64: null,
      totalCiphertextSize: paddedSize,
    },
    mac,
    uploadHashB64: null,
    folderNodeId: folder.nodeId,
  };
}

export async function uploadCiphertext(
  api: MegaApi,
  state: AssembleMegaState,
  ciphertext: Uint8Array,
): Promise<AssembleMegaState> {
  const transfer = { ...state.transfer };
  let data = ciphertext;
  if (transfer.remainingBufferB64) {
    data = concat(fromB64(transfer.remainingBufferB64), ciphertext);
    transfer.remainingBufferB64 = null;
  }

  let dataOffset = 0;
  let position = transfer.bytesUploaded;
  let currentChunkSize = transfer.currentChunkSize;
  let uploadHashB64 = state.uploadHashB64;

  while (dataOffset < data.length) {
    const chunkSize = Math.min(currentChunkSize, transfer.totalCiphertextSize - position);
    if (chunkSize <= 0) break;

    let chunk = data.slice(dataOffset, dataOffset + chunkSize);
    dataOffset += chunk.length;

    if (chunk.length < chunkSize) {
      transfer.remainingBufferB64 = b64(chunk);
      break;
    }

    const hash = await postChunk(api, state.uploadUrl, position, chunk);
    position += chunk.length;
    transfer.bytesUploaded = position;

    if (hash.length > 0) {
      uploadHashB64 = b64(hash);
      break;
    }

    if (currentChunkSize < MAX_CHUNK_SIZE) {
      currentChunkSize += CHUNK_SIZE_INCREMENT;
    }
    transfer.currentChunkSize = currentChunkSize;
  }

  return {
    ...state,
    transfer,
    uploadHashB64,
  };
}

export async function finalizeMegaFile(
  storage: MegaStorage,
  folder: MegaFolder,
  filename: string,
  state: AssembleMegaState,
): Promise<MegaUploadedFile> {
  if (!state.uploadHashB64) {
    throw new Error('Mega upload is not complete yet.');
  }

  const fileKey = fromB64(state.fileKeyB64);
  const aes = new Aes128(fileKey.slice(0, 16));
  const mac = Mac.fromState(aes, fileKey.slice(16), state.mac);
  const macCondensed = mac.condense();
  const finalKey = mergeKeyMac(fileKey, macCondensed);

  const at = packAttributes({ n: filename });
  const cipher = createCipheriv('aes-128-ecb', finalKey.slice(0, 16), Buffer.alloc(0));
  cipher.setAutoPadding(false);
  const encryptedAt = new Uint8Array(cipher.update(at));

  const storedKey = Uint8Array.from(finalKey.slice(0, 24));
  storage.aes.encryptECB(storedKey);

  const fileObject = {
    h: e64(fromB64(state.uploadHashB64)),
    t: 0,
    a: e64(encryptedAt),
    k: e64(storedKey),
  };

  const request = {
    a: 'p',
    t: folder.nodeId,
    n: [fileObject],
  };

  return new Promise((resolve, reject) => {
    storage.api.request(request, (err, response) => {
      if (err) return reject(err);
      const nodes = (response as { f?: Record<string, unknown>[] })?.f;
      if (!nodes?.[0]) return reject(new Error('Mega did not create the file.'));
      resolve(storage._importFile(nodes[0]));
    });
  });
}

export async function connectHacknetFolder(storage: MegaStorage): Promise<MegaFolder> {
  const folderId = Deno.env.get('MEGA_HACKNET_FOLDER_ID');
  if (folderId && storage.files[folderId]?.directory) {
    return storage.files[folderId] as MegaFolder;
  }
  if (!storage.root) throw new Error('Mega login failed to initialize storage root.');
  const root = storage.root as MegaFolder & { children?: MegaFolder[] };
  let folder = root.children?.find((c) => c.name === 'Hacknet');
  if (!folder) {
    const created = await (root as { mkdir: (n: string) => Promise<MegaFolder> }).mkdir('Hacknet');
    folder = created;
  }
  return folder;
}
