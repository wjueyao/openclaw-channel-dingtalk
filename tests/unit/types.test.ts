import { describe, expect, it } from 'vitest';
import { listDingTalkAccountIds, resolveDingTalkAccount } from '../../src/types';

describe('types helpers', () => {
    it('lists default and named account ids', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'cli_default',
                    accounts: {
                        main: { clientId: 'cli_main', clientSecret: 'sec_main' },
                        backup: { clientId: 'cli_bak', clientSecret: 'sec_bak' },
                    },
                },
            },
        } as any;

        expect(listDingTalkAccountIds(cfg)).toEqual(['default', 'main', 'backup']);
    });

    it('resolves default account from top-level config', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'cli_default',
                    clientSecret: 'sec_default',
                    robotCode: 'robot_default',
                    dmPolicy: 'allowlist',
                    displayNameResolution: 'all',
                },
            },
        } as any;

        const account = resolveDingTalkAccount(cfg, 'default');

        expect(account.accountId).toBe('default');
        expect(account.clientId).toBe('cli_default');
        expect(account.robotCode).toBe('robot_default');
        expect(account.displayNameResolution).toBe('all');
        expect(account.configured).toBe(true);
    });

    it('resolves default account HTTP callback config from top-level config', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'cli_default',
                    clientSecret: 'sec_default',
                    mode: 'http',
                    httpPort: 8088,
                    webhookPath: '/custom/callback',
                },
            },
        } as any;

        const account = resolveDingTalkAccount(cfg, 'default');

        expect(account.mode).toBe('http');
        expect(account.httpPort).toBe(8088);
        expect(account.webhookPath).toBe('/custom/callback');
    });

    it('resolves named account with channel-level defaults and falls back to empty when account missing', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    dmPolicy: 'allowlist',
                    messageType: 'card',
                    accounts: {
                        main: { clientId: 'cli_main', clientSecret: 'sec_main', enabled: true },
                    },
                },
            },
        } as any;

        const main = resolveDingTalkAccount(cfg, 'main');
        const missing = resolveDingTalkAccount(cfg, 'not_found');

        expect(main.accountId).toBe('main');
        expect(main.configured).toBe(true);
        expect(main.dmPolicy).toBe('allowlist');
        expect(main.messageType).toBe('card');
        expect((main as any).accounts).toBeUndefined();
        expect(missing).toEqual({
            clientId: '',
            clientSecret: '',
            accountId: 'not_found',
            configured: false,
        });
    });

    it('resolves default account with mediaMaxMb from config', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'cli',
                    clientSecret: 'sec',
                    mediaMaxMb: 50,
                    aicardDegradeMs: 120000,
                    bypassProxyForSend: true,
                },
            },
        } as any;

        const account = resolveDingTalkAccount(cfg, 'default');
        expect(account.mediaMaxMb).toBe(50);
        expect(account.aicardDegradeMs).toBe(120000);
        expect(account.bypassProxyForSend).toBe(true);
        expect(account.aicardDegradeMs).toBe(120000);
        expect(account.bypassProxyForSend).toBe(true);
    });

    it('resolves named account with inherited bypassProxyForSend default', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    bypassProxyForSend: true,
                    learningEnabled: true,
                    allowFrom: ['owner-test-id'],
                    learningAutoApply: true,
                    learningNoteTtlMs: 120000,
                    accounts: {
                        main: { clientId: 'cli_main', clientSecret: 'sec_main' },
                    },
                },
            },
        } as any;

        const account = resolveDingTalkAccount(cfg, 'main');
        expect(account.bypassProxyForSend).toBe(true);
        expect(account.learningEnabled).toBe(true);
        expect(account.allowFrom).toEqual(['owner-test-id']);
        expect(account.learningAutoApply).toBe(true);
        expect(account.learningNoteTtlMs).toBe(120000);
    });

    it('resolves named account with inherited HTTP defaults unless overridden', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    mode: 'http',
                    httpPort: 3001,
                    webhookPath: '/dingtalk/callback',
                    accounts: {
                        main: { clientId: 'cli_main', clientSecret: 'sec_main' },
                        backup: {
                            clientId: 'cli_backup',
                            clientSecret: 'sec_backup',
                            httpPort: 9090,
                            webhookPath: '/backup/callback',
                        },
                    },
                },
            },
        } as any;

        const main = resolveDingTalkAccount(cfg, 'main');
        const backup = resolveDingTalkAccount(cfg, 'backup');

        expect(main.mode).toBe('http');
        expect(main.httpPort).toBe(3001);
        expect(main.webhookPath).toBe('/dingtalk/callback');

        expect(backup.mode).toBe('http');
        expect(backup.httpPort).toBe(9090);
        expect(backup.webhookPath).toBe('/backup/callback');
    });

    it('resolves journalTTLDays from top-level and named account config', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'cli_default',
                    clientSecret: 'sec_default',
                    journalTTLDays: 7,
                    accounts: {
                        main: { clientId: 'cli_main', clientSecret: 'sec_main', journalTTLDays: 21 },
                    },
                },
            },
        } as any;

        expect(resolveDingTalkAccount(cfg, 'default').journalTTLDays).toBe(7);
        expect(resolveDingTalkAccount(cfg, 'main').journalTTLDays).toBe(21);
    });
});
