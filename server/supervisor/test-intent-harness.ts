import { extractCanonicalIntent } from './intent-extractor';

const SAMPLE_INPUTS = [
  'find 10 pubs in Arundel that serve food',
  'pubs in Brighton with a beer garden',
  'best cafes in London',
  'find restaurants in Manchester opened in last 6 months',
  'dentists near Leeds with wheelchair access',
  'find offices in Bristol with air conditioning and parking',
  'micropubs in Sussex UK',
  'find bars in Soho that serve cocktails',
  'gyms in Edinburgh with a swimming pool',
  'find 5 hotels in Bath, include email and phone',
  'pubs in Bristol run by Greene King',
  'asdfgh jklzxcv qwerty',
  'find the vibes in Camden',
  'how accurate are your results?',
  'find cheap restaurants in York',
];

const SEP = '─'.repeat(72);

async function main() {
  console.log(`\nIntent Extractor Shadow Harness — ${SAMPLE_INPUTS.length} samples\n${SEP}`);

  for (let i = 0; i < SAMPLE_INPUTS.length; i++) {
    const msg = SAMPLE_INPUTS[i];
    console.log(`\n[${i + 1}/${SAMPLE_INPUTS.length}] "${msg}"`);

    const result = await extractCanonicalIntent(msg);
    const v = result.validation;

    console.log(`  validation_ok : ${v.ok}`);

    if (v.ok && v.intent) {
      const it = v.intent;
      console.log(`  action        : ${it.action}`);
      console.log(`  business_type : ${it.business_type ?? '(none)'}`);
      console.log(`  location      : ${it.location ?? '(none)'}`);
      console.log(`  country       : ${it.country ?? '(none)'}`);
      console.log(`  count         : ${it.count ?? '(none)'}`);
      console.log(`  confidence    : ${it.confidence}`);
      console.log(`  delivery      : email=${it.delivery_requirements.email} phone=${it.delivery_requirements.phone} website=${it.delivery_requirements.website}`);

      if (it.constraints.length === 0) {
        console.log(`  constraints   : (none)`);
      } else {
        for (const c of it.constraints) {
          console.log(`  constraint    : type=${c.type}  evidence=${c.evidence_mode}  hardness=${c.hardness}  clarify=${c.clarify_if_needed}  raw="${c.raw}"`);
        }
      }
    } else {
      console.log(`  errors        : ${v.errors.join('; ')}`);
    }

    console.log(`  model=${result.model}  duration=${result.duration_ms}ms`);
    console.log(SEP);
  }
}

main().catch((err) => {
  console.error('Harness failed:', err);
  process.exit(1);
});
