import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Helpers ────────────────────────────────────────────────────────────────

function getMondayKey(): string {
  const now = new Date()
  const day = now.getDay()                          // 0=dim … 6=sam
  const diff = day === 0 ? -6 : 1 - day            // décalage vers lundi
  const monday = new Date(now)
  monday.setDate(now.getDate() + diff)
  return monday.toISOString().split('T')[0]         // 'YYYY-MM-DD'
}

function buildEmailHtml(name: string, weekKey: string, appUrl: string): string {
  const [year, month, day] = weekKey.split('-')
  const dateLabel = `${day}/${month}/${year}`
  return `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F7F5F2;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F5F2;padding:32px 16px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #E2DDD8">

        <!-- En-tête -->
        <tr>
          <td style="background:#A6C5BD;padding:24px 32px">
            <p style="margin:0;font-size:20px;font-weight:700;color:#1C1917;letter-spacing:-.02em">
              ☕ Terrasse Café
            </p>
          </td>
        </tr>

        <!-- Corps -->
        <tr>
          <td style="padding:32px">
            <p style="margin:0 0 16px;font-size:16px;color:#1C1917">
              Bonjour <strong>${name}</strong>,
            </p>
            <p style="margin:0 0 16px;font-size:15px;color:#57534E;line-height:1.6">
              On n'a pas encore reçu tes disponibilités pour la semaine du
              <strong style="color:#1C1917">${dateLabel}</strong>.
            </p>
            <p style="margin:0 0 28px;font-size:15px;color:#57534E;line-height:1.6">
              Si tu n'es pas disponible cette semaine, tu peux soumettre
              avec <strong>quota&nbsp;=&nbsp;0</strong> pour nous le faire savoir.
            </p>

            <!-- Bouton -->
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#A6C5BD;border-radius:7px">
                  <a href="${appUrl}"
                     style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#1C1917;text-decoration:none">
                    Soumettre mes disponibilités →
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Pied de page -->
        <tr>
          <td style="padding:16px 32px 24px;border-top:1px solid #E2DDD8">
            <p style="margin:0;font-size:12px;color:#706A65;line-height:1.5">
              Tu reçois ce message parce que tu es bénévole au Terrasse Café.<br>
              Merci de ta contribution !
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

// ── Handler principal ───────────────────────────────────────────────────────

Deno.serve(async (req) => {

  // 1. Vérification du secret partagé
  // const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
  // const authHeader  = req.headers.get('Authorization') ?? ''
  // if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
  //   return new Response('Unauthorized', { status: 401 })
  // }

  // 2. Clients
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
  const RESEND_KEY = Deno.env.get('RESEND_API_KEY')!
  const APP_URL    = Deno.env.get('APP_URL')!          // ex: https://monrepo.github.io

  // 3. Semaine courante
  const weekKey = getMondayKey()

  // 4. Bénévoles actifs avec email
  const { data: volunteers, error: volErr } = await supabase
    .from('people')
    .select('name, email')
    .eq('type', 'vol')
    .eq('active', true)
    .not('email', 'is', null)
    .neq('email', '')

  if (volErr) {
    console.error('Erreur lecture people:', volErr)
    return new Response(JSON.stringify({ error: volErr.message }), { status: 500 })
  }

  // 5. Bénévoles qui ont déjà soumis (quota=0 inclus = ont répondu)
  const { data: submitted, error: subErr } = await supabase
    .from('availabilities')
    .select('person_name')
    .eq('week_key', weekKey)

  if (subErr) {
    console.error('Erreur lecture availabilities:', subErr)
    return new Response(JSON.stringify({ error: subErr.message }), { status: 500 })
  }

  const submittedNames = new Set(submitted?.map(a => a.person_name) ?? [])

  // 6. Filtrer ceux qui n'ont pas encore répondu
  const toRemind = (volunteers ?? []).filter(v => !submittedNames.has(v.name))

  console.log(`Semaine ${weekKey} — ${toRemind.length}/${volunteers?.length} bénévoles à relancer`)

  // 7. Envoi des courriels
  const results = await Promise.allSettled(
    toRemind.map(async (v) => {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Terrasse Café <onboarding@resend.dev>',
          to:   v.email,
          subject: `📅 Disponibilités semaine du ${weekKey} — Terrasse Café`,
          html: buildEmailHtml(v.name, weekKey, APP_URL),
        }),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`${v.name} <${v.email}> → ${res.status}: ${body}`)
      }
      console.log(`✓ Rappel envoyé à ${v.name} (${v.email})`)
      return v.name
    })
  )

  // 8. Rapport
  const sent   = results.filter(r => r.status === 'fulfilled').length
  const failed = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map(r => r.reason?.message ?? 'Erreur inconnue')

  if (failed.length) console.error('Échecs:', failed)

  return new Response(
    JSON.stringify({ weekKey, sent, skipped: submittedNames.size, failed }),
    { headers: { 'Content-Type': 'application/json' } }
  )
})
