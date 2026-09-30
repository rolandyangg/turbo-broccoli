import { faker } from '@faker-js/faker';

export const STRESS_KINDS = ['realistic', 'long-word', 'long-text', 'huge-paste', 'emoji', 'cjk', 'rtl', 'zalgo', 'whitespace', 'empty', 'german'] as const;
export type StressKind = (typeof STRESS_KINDS)[number];

export function stressValue(kind: StressKind, field: { type?: string | null; name?: string | null; autocomplete?: string | null; maxLength?: number | null } = {}): string {
  switch (kind) {
    case 'realistic':
      return realistic(field);
    case 'long-word':
      return 'Supercalifragilisticexpialidocious' + 'Donaudampfschifffahrtsgesellschaftskapitän';
    case 'long-text':
      return faker.lorem.sentence(40).slice(0, 220);
    case 'huge-paste':
      return faker.lorem.paragraphs(30).slice(0, 5000);
    case 'emoji':
      return '👩‍👩‍👧‍👦🏳️‍🌈🧑🏽‍💻🎉🔥 Ünïcödé naïve café 🥳🥳🥳🥳🥳🥳🥳🥳';
    case 'cjk':
      return '株式会社サンプル国際事業開発本部長兼グローバル戦略室長 김민준 张伟伟';
    case 'rtl':
      return 'مرحبا بالعالم هذا نص طويل جدا لاختبار الاتجاه من اليمين إلى اليسار';
    case 'zalgo':
      return 'Z̷̢̛̖͇̓a̸̟̓̍l̶̳̓͝g̶̱̈́͝o̴̤͑̓ ̵̰̀t̸͓̆e̴͖̿x̸̙̌t̶̨̛';
    case 'whitespace':
      return '      ';
    case 'empty':
      return '';
    case 'german':
      return 'Rechtsschutzversicherungsgesellschaften Kraftfahrzeughaftpflichtversicherung';
  }
}

function realistic(field: { type?: string | null; name?: string | null; autocomplete?: string | null }): string {
  const hint = `${field.type ?? ''} ${field.name ?? ''} ${field.autocomplete ?? ''}`.toLowerCase();
  if (/email/.test(hint)) return faker.internet.email();
  if (/tel|phone/.test(hint)) return faker.phone.number();
  if (/url|website/.test(hint)) return faker.internet.url();
  if (/number|qty|quantity|age/.test(hint)) return String(faker.number.int({ min: 1, max: 99 }));
  if (/date/.test(hint)) return '2026-04-15';
  if (/zip|postal/.test(hint)) return faker.location.zipCode();
  if (/city/.test(hint)) return faker.location.city();
  if (/address|street/.test(hint)) return faker.location.streetAddress();
  if (/company|org/.test(hint)) return faker.company.name();
  if (/pass/.test(hint)) return faker.internet.password({ length: 14 });
  if (/name/.test(hint)) return faker.person.fullName();
  if (/search|query|q\b/.test(hint)) return faker.commerce.productName();
  return faker.lorem.words(3);
}

/** Longer replacement text for label-mutation (translation stress). */
export function mutatedText(original: string, factor = 2.5, locale?: string): string {
  const base = original.trim() || 'Label';
  if (locale === 'de') return base.split(/\s+/).map((w) => w + 'ungsverwaltung').join(' ');
  if (locale === 'fi') return base.split(/\s+/).map((w) => w + 'lentokonesuihkuturbiini').join(' ');
  const target = Math.ceil(base.length * factor);
  let out = base;
  while (out.length < target) out += ' ' + base;
  return out.slice(0, Math.max(target, base.length + 4));
}
