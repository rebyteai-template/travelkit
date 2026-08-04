// Hex SHA-256 over WebCrypto — the one digest helper for worker + server code
// (token-rotation detection in task-do, credential fingerprints in
// tenant-credential). Pure and dependency-free.

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
