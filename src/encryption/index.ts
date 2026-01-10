import { toCryptoBuffer } from '../utils/buffers';

/**
 * @module Encryption
 * @description
 * Implements "Zero Knowledge" encryption using AES-GCM.
 * Run in the browser using window.crypto.subtle.
 */

export interface EncryptionAdapter {
    /** Encrypts a plaintext payload */
    encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
    /** Decrypts a ciphertext payload */
    decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
    /** Returns a unique ID for this key/adapter to verify consistency */
    getKeyId(): Promise<string>;
}

/**
 * AES-GCM Adapter
 * - Uses 256-bit keys
 * - Generates unique 12-byte IV for every encryption
 * - Prepends IV to ciphertext: [IV(12)][Ciphertext]
 */
export class AESGCMAdapter implements EncryptionAdapter {
    private key: CryptoKey | null = null;
    private keyMaterial: string;

    constructor(secretKey: string) {
        this.keyMaterial = secretKey;
    }

    /**
     * Initializes the CryptoKey from the raw secret string.
     * Uses PBKDF2 or SHA-256 (for simplicity in v1, we hash the string to 32 bytes).
     */
    async init(): Promise<void> {
        if (this.key) return;

        const encoder = new TextEncoder();
        const raw = encoder.encode(this.keyMaterial);

        // Hash the key to get consistent 32 bytes (SHA-256)
        const hash = await crypto.subtle.digest('SHA-256', raw);

        this.key = await crypto.subtle.importKey(
            'raw',
            hash,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
        if (!this.key) await this.init();
        if (!this.key) throw new Error('Encryption key not initialized');

        // Generate 12-byte IV
        const iv = crypto.getRandomValues(new Uint8Array(12));

        const ciphertextParams = await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: iv
            },
            this.key,
            toCryptoBuffer(plaintext)
        );
        const ciphertext = new Uint8Array(ciphertextParams);

        // Concatenate IV + Ciphertext
        const result = new Uint8Array(iv.length + ciphertext.length);
        result.set(iv);
        result.set(ciphertext, iv.length);

        return result;
    }

    async decrypt(payload: Uint8Array): Promise<Uint8Array> {
        if (!this.key) await this.init();
        if (!this.key) throw new Error('Encryption key not initialized');

        if (payload.length < 13) {
            throw new Error('Invalid payload: too short for IV + ciphertext');
        }

        // Extract IV (first 12 bytes)
        const iv = payload.slice(0, 12);
        const ciphertext = payload.slice(12);

        try {
            const plaintextParams = await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: iv
                },
                this.key,
                toCryptoBuffer(ciphertext)
            );
            return new Uint8Array(plaintextParams);
        } catch (e) {
            console.error('Decryption failed', e);
            throw new Error('Decryption failed: Invalid key or corrupted data');
        }
    }

    async getKeyId(): Promise<string> {
        // Return first 8 chars of key hash as ID
        const encoder = new TextEncoder();
        const raw = encoder.encode(this.keyMaterial);
        const hash = await crypto.subtle.digest('SHA-256', raw);
        const hashArray = Array.from(new Uint8Array(hash));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
    }
}
