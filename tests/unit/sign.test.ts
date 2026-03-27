import { describe, expect, it } from 'vitest';
import { generateDingTalkSignature, verifyDingTalkSignature } from '../../src/signature';

describe('generateDingTalkSignature', () => {
    it('should generate stable HmacSHA256 + Base64 signature for fixed timestamp/secret', () => {
        const timestamp = '1700000000000';
        const secret = 'SECabc123';

        const result = generateDingTalkSignature(timestamp, secret);

        expect(result).toBe('N5P09a4+p1AMJIJWnIvQd2Yxw9+fu/oEBnPrjCcsLXk=');
    });

    it('should throw when secret is empty', () => {
        expect(() => generateDingTalkSignature(1700000000000, '')).toThrow(
            'secret is required for DingTalk signature generation'
        );
    });
});

describe('verifyDingTalkSignature', () => {
    it('returns true for valid timestamp/sign/secret', () => {
        const timestamp = '1700000000000';
        const secret = 'SECabc123';
        const sign = generateDingTalkSignature(timestamp, secret);

        expect(
            verifyDingTalkSignature({
                timestamp,
                sign,
                secret,
                now: Number(timestamp),
            })
        ).toBe(true);
    });

    it('returns false for invalid sign', () => {
        expect(
            verifyDingTalkSignature({
                timestamp: '1700000000000',
                sign: 'invalid-sign',
                secret: 'SECabc123',
                now: 1700000000000,
            })
        ).toBe(false);
    });

    it('returns false for expired timestamp', () => {
        const timestamp = '1700000000000';
        const secret = 'SECabc123';
        const sign = generateDingTalkSignature(timestamp, secret);

        expect(
            verifyDingTalkSignature({
                timestamp,
                sign,
                secret,
                now: 1700000000000 + 60 * 60 * 1000 + 1,
            })
        ).toBe(false);
    });
});
