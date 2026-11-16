// node --test test/contacts.test.mjs — the forgiving contact-book lookup (phone/contacts.js). Fake book, no calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContacts, matchContact, phonetic, normName } from '../src/phone/contacts.js';

const docs = [
  { id: 'KB-contacts', kind: 'knowledge', body: [
    '# Contacts', '', '## People',
    '- **Mick Dev (Versa Jambonz)** — phone +61400000011',
    '- **Nick Crosley** — phone +61400000012',
    '- **RACQ Roadside Assistance** — phone +61400000013',
    '- **Rik Bobcat Operator** — phone +61400000001',
    '- **Rik Jonson** - phone +61400000002',
    '- **Shane (Excavator Driver)** — phone +61400000003',
    '- **Stephen Clarke** — phone +61400000004 · Versa',
    '- **Dad** — phone +61400000005',
    '- **Michael Dunbar** - phone +61400000005',
    '', '## Team dinner group (DEMO)', 'Every number is the owner\'s own mobile.',
    '- Sarah (team dinner group): +61400000006',
    '- Sunny (Sunny & Co.) — Jordan\'s mate and the team\'s go-to contact for a quick yes/no: +61400000007'
  ].join('\n') },
  { id: 'KB-family', kind: 'knowledge', body: '- **Dad** (Mick\'s father) - phone +61400000005. "Call Dad", "text Dad" all mean this number.' },
  { id: 'SOP-001', kind: 'sop', body: '- call 000 in an emergency +61 000 000 000' }
];
const book = parseContacts(docs);

test('every name → number line is parsed; SOPs are not contacts', () => {
  const names = book.map((c) => c.name);
  assert.deepEqual(names, ['Mick Dev', 'Nick Crosley', 'RACQ Roadside Assistance', 'Rik Bobcat Operator', 'Rik Jonson', 'Shane', 'Stephen Clarke', 'Dad', 'Michael Dunbar', 'Sarah', 'Sunny', 'Dad']);
  assert.deepEqual(book.find((c) => c.name === 'Shane').aliases, ['Excavator Driver']);
  assert.equal(book.find((c) => c.name === 'Sunny').number, '+61400000007');
});

test('sound-alikes share a key', () => {
  assert.equal(phonetic('Rick'), phonetic('Rik'));
  assert.equal(phonetic('Johnson'), phonetic('Jonson'));
  assert.equal(phonetic('Steven'), phonetic('Stephen'));
  assert.equal(phonetic('Clark'), phonetic('Clarke'));
  assert.notEqual(phonetic('Sarah'), phonetic('Shane'));
  assert.deepEqual(normName("my Dad's"), ['dad']);
});

test('"Rick" is ambiguous between the two Riks — the caller is asked, never guessed', () => {
  const r = matchContact(book, 'Rick');
  assert.equal(r.ambiguous, true);
  assert.equal(r.number, '');
  assert.deepEqual(r.candidates.map((c) => c.name), ['Rik Bobcat Operator', 'Rik Jonson'], 'Mick, Nick and RACQ are not Rick');
  assert.equal(matchContact(book, 'Mick').number, '+61400000011');
  assert.equal(matchContact(book, 'Nick').number, '+61400000012');
});

test('a surname, a role or a sound-alike surname resolves it', () => {
  assert.equal(matchContact(book, 'Rik Jonson').number, '+61400000002');
  assert.equal(matchContact(book, 'Rick Johnson').number, '+61400000002');
  assert.equal(matchContact(book, 'the bobcat operator').number, '+61400000001');
  assert.equal(matchContact(book, 'Steven Clark').number, '+61400000004');
  assert.equal(matchContact(book, 'the excavator driver').number, '+61400000003');
});

test('the same number in two docs is one answer, not an ambiguity', () => {
  const r = matchContact(book, 'my dad');
  assert.equal(r.ambiguous, false);
  assert.equal(r.number, '+61400000005');
});

test('nobody by that name', () => {
  const r = matchContact(book, 'Zebulon Quartermaine');
  assert.equal(r.number, '');
  assert.equal(r.ambiguous, false);
  assert.deepEqual(r.candidates, []);
});
