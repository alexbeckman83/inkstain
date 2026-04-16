// Inkstain onboarding email templates + dedup-aware sender.
// Brand: parchment #f5f2eb, ink #1B2A3B, amber #c8956b,
// Playfair Display headings, EB Garamond body.

const INK = '#1B2A3B';
const PARCH = '#f5f2eb';
const AMBER = '#c8956b';

function wrap(innerHtml) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;700&family=EB+Garamond:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:${PARCH};font-family:'EB Garamond',Georgia,serif;color:${INK};-webkit-font-smoothing:antialiased;">
  <div style="padding:48px 20px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:.5px solid rgba(27,42,59,.12);">
      <div style="padding:36px 40px 20px 40px;text-align:center;background:${INK};">
        <span style="font-family:'Playfair Display',Georgia,serif;font-weight:700;font-size:26px;letter-spacing:-.5px;color:${PARCH};">Ink<span style="color:${AMBER};">stain</span></span>
      </div>
      <div style="height:2px;background:${AMBER};"></div>
      <div style="padding:40px;">
        ${innerHtml}
      </div>
      <div style="padding:24px 40px 36px 40px;border-top:.5px solid rgba(27,42,59,.08);text-align:center;">
        <p style="margin:0;font-family:'EB Garamond',Georgia,serif;font-style:italic;font-size:13px;color:rgba(27,42,59,.45);">
          The written word will prevail. · <a href="https://inkstain.ai" style="color:rgba(27,42,59,.45);text-decoration:none;">inkstain.ai</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function heading(text) {
  return `<h1 style="margin:0 0 20px 0;font-family:'Playfair Display',Georgia,serif;font-weight:500;font-size:30px;line-height:1.2;color:${INK};letter-spacing:-.5px;">${text}</h1>`;
}
function para(text) {
  return `<p style="margin:0 0 22px 0;font-family:'EB Garamond',Georgia,serif;font-size:17px;line-height:1.55;color:${INK};">${text}</p>`;
}
function primaryCta(label, href) {
  return `<p style="margin:8px 0 20px 0;"><a href="${href}" style="display:inline-block;background:${INK};color:${PARCH};padding:14px 26px;text-decoration:none;font-family:'Playfair Display',Georgia,serif;font-weight:500;font-size:16px;letter-spacing:.3px;">${label}</a></p>`;
}
function secondaryLink(label, href) {
  return `<p style="margin:0 0 6px 0;font-family:'EB Garamond',Georgia,serif;font-size:15px;"><a href="${href}" style="color:${AMBER};text-decoration:none;">${label}</a></p>`;
}

// ── 6 templates ──────────────────────────────────────────────────────────────
const templates = {
  publisher_welcome: (d) => ({
    subject: 'Your Inkstain publisher account is ready',
    html: wrap(
      heading("You're in.") +
      para(`Welcome to Inkstain${d.orgName ? `, ${escapeHtml(d.orgName)}` : ''}. Your publisher dashboard is live. The next step is inviting your first contributor — send them your invite link and they'll be automatically associated with your publication.`) +
      primaryCta('Go to your dashboard →', 'https://inkstain.ai/publishers/dashboard') +
      secondaryLink('View your invite link →', 'https://inkstain.ai/publishers/dashboard#invite')
    ),
  }),

  publisher_first_contributor: (d) => ({
    subject: `${d.contributorName || 'A contributor'} just joined your Inkstain dashboard`,
    html: wrap(
      heading('Your first contributor is in.') +
      para(`${escapeHtml(d.contributorName || 'A contributor')} has joined ${escapeHtml(d.publisherName || 'your publication')} on Inkstain. Their Trail is now active. When they submit a piece, ask them to include their Inkstain certificate. You can verify it in seconds from your dashboard.`) +
      primaryCta('View contributors →', 'https://inkstain.ai/publishers/dashboard#contributors') +
      secondaryLink('Learn how verification works →', 'https://inkstain.ai/publishers/dashboard#verify')
    ),
  }),

  publisher_first_verify: (d) => ({
    subject: 'You just verified your first Inkstain certificate',
    html: wrap(
      heading("That's what it feels like.") +
      para("You've verified your first Trail certificate. That's the standard — one click, full provenance, no ambiguity. Invite more contributors and make it your policy for every submission.") +
      primaryCta('Invite more contributors →', 'https://inkstain.ai/publishers/dashboard#invite') +
      para(`<span style="color:rgba(27,42,59,.6);font-size:16px;">Ready to make it official? <a href="https://inkstain.ai/publishers/dashboard#billing" style="color:${AMBER};text-decoration:none;">Upgrade to a paid plan</a> and unlock the full policy engine.</span>`)
    ),
  }),

  author_welcome: (d) => ({
    subject: "You're in. Start your Trail.",
    html: wrap(
      heading('Your Trail starts now.') +
      para('Inkstain is running. Every word you write from here is witnessed. When you\'re ready to submit a piece, generate your Trail certificate from the desktop agent — it takes one click.') +
      (d.publisherName
        ? para(`You've been added to <strong>${escapeHtml(d.publisherName)}</strong>'s contributor list. They'll be able to verify your certificates directly from their dashboard.`)
        : '') +
      primaryCta('Download the desktop agent →', 'https://inkstain.ai#download') +
      secondaryLink('Generate your first certificate →', 'https://inkstain.ai/trail')
    ),
  }),

  author_first_certificate: (d) => ({
    subject: 'Your first Trail certificate is ready',
    html: wrap(
      heading('Your first certificate.') +
      para("You've generated your first Inkstain Trail certificate. This is your proof of authorship — a signed, timestamped record of how this piece was made. Share the verification hash with your editor or attach the PDF to your submission.") +
      primaryCta('View your certificates →', 'https://inkstain.ai/account') +
      secondaryLink('How to share your certificate →', 'https://inkstain.ai#how-it-works')
    ),
  }),

  author_certificate_verified: (d) => ({
    subject: `${d.publisherName || 'Your publisher'} verified your Trail certificate`,
    html: wrap(
      heading('Verified.') +
      para(`${escapeHtml(d.publisherName || 'Your publisher')} just verified your Trail certificate for "${escapeHtml(d.articleTitle || 'your recent submission')}". Your provenance is on record. This is what protection looks like.`) +
      primaryCta('View your account →', 'https://inkstain.ai/account')
    ),
  }),
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Sender with dedup ────────────────────────────────────────────────────────
// Atomically reserves the (recipient_id, email_key) slot via INSERT ... ON
// CONFLICT DO NOTHING. Only the insert winner sends the email; races are safe.
async function sendOnboardingEmail(pool, sendEmail, {
  recipientEmail,
  recipientType,   // 'publisher' | 'author'
  recipientId,
  emailKey,        // template key (also the default dedup slot)
  dedupKey,        // optional — override the (recipient_id, slot) dedup key when
                   // the same template may legitimately fire multiple times for
                   // different contexts (e.g. per-certificate verification)
  triggeredBy,     // 'account_created' | 'first_contributor' | 'first_certificate' | 'certificate_verified'
  templateData = {},
}) {
  try {
    if (!recipientEmail || !recipientId || !emailKey) return { sent: false, reason: 'missing args' };
    const tmpl = templates[emailKey];
    if (!tmpl) return { sent: false, reason: 'unknown template: ' + emailKey };
    const slotKey = dedupKey || emailKey;

    // Atomic reservation; if row exists we lose the race and skip.
    const reserve = await pool.query(
      `INSERT INTO scheduled_emails (recipient_email, recipient_type, recipient_id, email_key, triggered_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (recipient_id, email_key) DO NOTHING
       RETURNING id`,
      [recipientEmail, recipientType, recipientId, slotKey, triggeredBy]
    );
    if (reserve.rows.length === 0) return { sent: false, reason: 'already sent' };

    const reservationId = reserve.rows[0].id;
    const { subject, html } = tmpl(templateData);
    try {
      const result = await sendEmail(recipientEmail, subject, html);
      await pool.query('UPDATE scheduled_emails SET sent_at=NOW() WHERE id=$1', [reservationId]);
      return { sent: true, result };
    } catch (sendErr) {
      // Release the dedup slot so a future trigger can retry; otherwise a
      // transient provider outage permanently suppresses this onboarding email.
      await pool.query('DELETE FROM scheduled_emails WHERE id=$1', [reservationId])
        .catch(e => console.error('[onboarding] release reservation failed:', e));
      console.error('[onboarding] delivery failed, slot released:', emailKey, sendErr);
      return { sent: false, reason: 'delivery error' };
    }
  } catch (err) {
    console.error('[onboarding] send failed:', emailKey, err);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { sendOnboardingEmail, templates };
