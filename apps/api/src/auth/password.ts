import { hash, verify } from "@node-rs/argon2";

// argon2id with the library defaults (OWASP: m=19 MiB, t=2, p=1) (SEC-1).
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// An unknown email still costs one verify, so response time doesn't reveal which emails exist.
let dummy: Promise<string> | undefined;
export async function burnVerify(password: string): Promise<void> {
  dummy ??= hashPassword("caseguard-dummy-password");
  await verifyPassword(await dummy, password);
}
