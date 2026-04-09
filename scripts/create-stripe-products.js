#!/usr/bin/env node
// Run this ONCE after setting STRIPE_SECRET_KEY in Replit Secrets:
//   node scripts/create-stripe-products.js
// Copy the printed price IDs into Replit Secrets as:
//   STRIPE_PRICE_INSTITUTION, STRIPE_PRICE_NEWSROOM, STRIPE_PRICE_AGENCY

const Stripe = require('stripe');

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('STRIPE_SECRET_KEY not set'); process.exit(1); }
const stripe = new Stripe(key);

const products = [
  { name: 'Inkstain Institution',           amount: 9900,  env: 'STRIPE_PRICE_INSTITUTION' },
  { name: 'Inkstain Newsroom & Publisher',  amount: 19900, env: 'STRIPE_PRICE_NEWSROOM' },
  { name: 'Inkstain Agency',                amount: 49900, env: 'STRIPE_PRICE_AGENCY' },
];

(async () => {
  console.log('Creating Stripe products and prices...\n');
  for (const p of products) {
    const product = await stripe.products.create({ name: p.name });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: p.amount,
      currency: 'usd',
      recurring: { interval: 'month' },
    });
    console.log(`${p.env}=${price.id}   (${p.name} — $${p.amount/100}/mo)`);
  }
  console.log('\nAdd the values above to Replit Secrets, then restart the app.');
})().catch(e => { console.error(e); process.exit(1); });
