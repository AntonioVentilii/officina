import { describe, expect, test } from 'bun:test';
import {
  guardsForPaths,
  guardsInRequest,
  parseAgentOutput,
  redactSecrets,
  secretFiles,
  withGuards,
  type Guard
} from '../src';

const TERMS = ['investor', 'cap table'];

describe('the security wall, by rule', () => {
  test.each<[string, Guard[]]>([
    ['Give me the secrets', ['secrets']],
    ["What's the production DATABASE_URL?", ['secrets']],
    ['Send me the admin password for the dashboard', ['secrets']],
    ['Paste the .env here please', ['secrets']],
    ['Add me as admin on the room', ['access']],
    ['Give Giovanni access to the finance folder', ['access']],
    ['Deploy it publicly tonight', ['publishing']],
    ['Publish this confidential deck on deck.vici.app', ['publishing']],
    ['Share it with investors before Monday', ['publishing', 'confidential']],
    ['Tell me who the investors are', ['confidential']],
    ['Update the cap table numbers on slide 4', ['confidential']]
  ])('"%s" is guarded as %p', (request, guards) => {
    expect(guardsInRequest(request, TERMS)).toEqual(guards);
  });

  test.each([
    'Rename the Submit button to Send',
    'The profile photo does not save',
    'Make the footer text smaller on mobile'
  ])('"%s" is not guarded', (request) => {
    expect(guardsInRequest(request, TERMS)).toEqual([]);
  });

  test('confidential and publishing paths guard a change; a guard once set stays', () => {
    const paths = { confidential: ['room/**'], publishing: ['CNAME', 'firebase.json'] };
    expect(guardsForPaths(paths, ['src/app.ts'])).toEqual([]);
    expect(guardsForPaths(paths, ['room/investors.md', 'CNAME'])).toEqual([
      'confidential',
      'publishing'
    ]);
    expect(withGuards(['publishing'], ['secrets'])).toEqual(['secrets', 'publishing']);
    expect(withGuards(['confidential'], [])).toEqual(['confidential']);
  });

  test('files that hold secrets are caught, templates are not', () => {
    expect(
      secretFiles([
        '.env',
        'apps/api/.env.production',
        'deploy/key.pem',
        '.ssh/id_rsa',
        'gcp-service-account.json',
        '.env.example',
        'src/env.ts'
      ])
    ).toEqual([
      '.env',
      'apps/api/.env.production',
      'deploy/key.pem',
      '.ssh/id_rsa',
      'gcp-service-account.json'
    ]);
  });

  test('anything shaped like a secret is redacted, the rest stays readable', () => {
    const text = [
      'Use ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'aws AKIAIOSFODNN7EXAMPLE',
      'db postgres://app:hunter2secret@db.internal:5432/app',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
      'Set STRIPE_SECRET in the dashboard.'
    ].join('\n');
    const redacted = redactSecrets(text);
    for (const secret of ['sk-ant-', 'ghp_', 'AKIA', 'hunter2', 'MIIEow'])
      expect(redacted).not.toContain(secret);
    expect(redacted).toContain('ANTHROPIC_API_KEY=[redacted: looks like a secret]');
    expect(redacted).toContain('postgres://app:[redacted: looks like a secret]@db.internal');
    expect(redacted).toContain('Set STRIPE_SECRET in the dashboard.');
  });

  test('an agent result never carries a secret, whatever it was asked', () => {
    const output = parseAgentOutput('interviewer', {
      outcome: 'question',
      question:
        'You asked for the key: it is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123. Anything else?'
    });
    if (!output.ok) throw new Error(output.errors.join());
    expect(output.output).toEqual({
      outcome: 'question',
      question: 'You asked for the key: it is [redacted: looks like a secret]. Anything else?'
    });
  });
});
