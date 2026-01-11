
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncEngine } from '../src/engine';
import { InMemoryAdapter } from '../src/adapters/InMemoryAdapter';
import { AESGCMAdapter } from '../src/encryption';
import { decodeValue, encodeValue } from '../src/protocol';

// Mock crypto for Node.js environment (Vitest runs in Node)
// const crypto = require('crypto').webcrypto;
// global.crypto = crypto;
// Actually Vitest environment 'jsdom' or 'node' usually handles this. 
// If 'happy-dom' is used, check support. 
// Assuming Node 20+, global.crypto is available.

describe('End-to-End Encryption', () => {
    const key = 'super-secret-password-123';
    let storage: InMemoryAdapter;
    let encryption: AESGCMAdapter;
    let engine: SyncEngine;

    beforeEach(async () => {
        storage = new InMemoryAdapter();
        encryption = new AESGCMAdapter(key);
        // Ensure keys are ready
        await encryption.init();

        // Pass encryption to engine
        engine = new SyncEngine('peer-A', storage, false, encryption);
    });

    it('should encrypt data written to storage', async () => {
        const secretData = { secret: 'nuclear launch codes' };

        // 1. Set data
        await engine.set('secret-key', secretData);

        // 2. Read directly from storage (bypassing engine decryption)
        const storedBytes = await storage.get('secret-key');
        expect(storedBytes).toBeDefined();

        // 3. Verify it is NOT the plaintext msgpack
        const plaintextBytes = encodeValue(secretData);
        expect(storedBytes).not.toEqual(plaintextBytes);

        // 4. Verify it IS an encrypted blob (starts with different bytes due to IV)
        // Should be at least IV (12) + GCM Tag (16) + MsgPack overhead
        expect(storedBytes!.length).toBeGreaterThan(28);

        // 5. Verify manual decryption works
        const decrypted = await encryption.decrypt(storedBytes!);
        // Decoded value should match original
        expect(decodeValue(decrypted)).toEqual(secretData);
    });

    it('should decrypt data read from storage', async () => {
        const secretData = { secret: 'area 51 location' };

        // 1. Set data
        await engine.set('area-51', secretData);

        // 2. Clear engine memory to force reload
        engine = new SyncEngine('peer-A', storage, false, encryption);

        // 3. Load from storage
        await engine.loadFromStorage();

        // 4. Verify engine state is decrypted
        expect(engine.get('area-51')).toEqual(secretData);
    });

    it('should sync between two clients with same key', async () => {
        const storageB = new InMemoryAdapter();
        const encryptionB = new AESGCMAdapter(key); // Same key
        const engineB = new SyncEngine('peer-B', storageB, false, encryptionB);

        // Client A generates op
        const payloadA = await engine.set('chat', 'hello spy');

        // PayloadA is ENCRYPTED

        // Client B receives remote op
        await engineB.applyRemote('chat', payloadA, 'peer-A');

        // Client B should see cleartext
        expect(engineB.get('chat')).toBe('hello spy');
    });

    it('should fail to decrypt if key is wrong', async () => {
        const logSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

        const storageC = new InMemoryAdapter();
        const encryptionC = new AESGCMAdapter('wrong-password');
        const engineC = new SyncEngine('peer-C', storageC, false, encryptionC);

        // Client A generates op
        const payloadA = await engine.set('msg', 'top secret');

        // Client C tries to apply
        await engineC.applyRemote('msg', payloadA, 'peer-A');

        // Should log error and NOT apply state
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Decryption failed'), expect.any(Error));
        expect(engineC.get('msg')).toBeUndefined();

        logSpy.mockRestore();
    });

    it('should encode isEncrypted flag on the wire', async () => {
        const secretData = 'classified';

        // 1. Manually encrypt payload
        const rawPayload = encodeValue(secretData);
        const encryptedPayload = await encryption.encrypt(rawPayload);

        // 2. Encode Op with isEncrypted=true
        // Import locally to ensure we get the updated module
        const { encodeOp, decodeMessage, MsgType } = await import('../src/protocol');

        const wireBytes = encodeOp('k1', encryptedPayload, 123456, true);

        // 3. Decode Message
        const decoded = decodeMessage(wireBytes);
        if (!decoded) throw new Error('Failed to decode message');

        // 4. Verify fields
        expect(decoded.type).toBe(MsgType.Op);
        expect(decoded.key).toBe('k1');
        expect(decoded.isEncrypted).toBe(true);
        expect(decoded.payload).toEqual(encryptedPayload);

        // 5. Verify plain op doesn't have the flag
        const plainWire = encodeOp('k2', rawPayload, 123456, false);
        const decodedPlain = decodeMessage(plainWire);
        if (!decodedPlain) throw new Error('Failed to decode plain message');
        expect(decodedPlain.isEncrypted).toBe(false);
    });

    it('should throw error on too-short payload decryption', async () => {
        // Payload must be at least 13 bytes (12 IV + 1 ciphertext)
        const shortPayload = new Uint8Array([1, 2, 3, 4, 5]);

        await expect(encryption.decrypt(shortPayload)).rejects.toThrow('Invalid payload: too short');
    });

    it('should return consistent key ID', async () => {
        const keyId1 = await encryption.getKeyId();
        const keyId2 = await encryption.getKeyId();

        expect(keyId1).toBe(keyId2);
        expect(keyId1.length).toBe(8); // 8 hex characters
    });

    it('should return different key IDs for different keys', async () => {
        const encryption2 = new AESGCMAdapter('different-secret-key');
        await encryption2.init();

        const keyId1 = await encryption.getKeyId();
        const keyId2 = await encryption2.getKeyId();

        expect(keyId1).not.toBe(keyId2);
    });

    it('should skip init if already initialized', async () => {
        const adapter = new AESGCMAdapter('secret');
        await adapter.init();
        const key1 = (adapter as any).key;
        expect(key1).toBeDefined();

        await adapter.init();
        const key2 = (adapter as any).key;
        expect(key1).toBe(key2);
    });

    it('should throw if decrypt is called before init (and init fails) (defensive check)', async () => {
        const adapter = new AESGCMAdapter('secret');
        // Sabotage init
        (adapter as any).init = async () => { };
        await expect(adapter.decrypt(new Uint8Array(20))).rejects.toThrow('Encryption key not initialized');
    });
});
