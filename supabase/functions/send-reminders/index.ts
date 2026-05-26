const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND_KEY   = Deno.env.get('RESEND_API_KEY')!
const APP_URL      = Deno.env.get('APP_URL')!

function getMondayKey(): string {
  const now = new Date()
  const day = now.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(now)
  monday.setDate(now.getDate() + diff)
  return monday.toISOString().split('T')[0]
}

function buildEmailHtml(name: string, weekKey: string, appUrl: string): string {
  const parts = weekKey.split('-')
  const dateLabel = parts[2]+'/'+parts[1]+'/'+parts[0]
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#F7F5F2;font-family:Arial,sans-serif"><table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center"><table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;border:1px solid #E2DDD8"><tr><td style="background:#A6C5BD;padding:24px 32px"><p style="margin:0;font-size:20px;font-weight:700;color:#1C1917">Terrasse Cafe</p></td></tr><tr><td style="padding:32px"><p style="margin:0 0 16px;font-size:16px;color:#1C1917">Bonjour '+name+',</p><p style="margin:0 0 16px;font-size:15px;color:#57534E;line-height:1.6">On na pas encore recu tes disponibilites pour la semaine du '+dateLabel+'.</p><p style="margin:0 0 28px;font-size:15px;color:#57534E;line-height:1.6">Si tu nes pas disponible, tu peux soumettre avec quota = 0.</p><a href="'+appUrl+'" style="background:#A6C5BD;border-radius:7px;padding:13px 28px;font-size:15px;font-weight:600;color:#1C1917;text-decoration:none">Soumettre mes disponibilites</a></td></tr><tr><td style="padding:16px 32px 24px;border-top:1px solid #E2DDD8"><p style="margin:0;font-size:12px;color:#706A65">Tu recois ce message parce que tu es benevole au Terrasse Cafe.</p></td></tr></table></td></tr></table></body></html>'
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function query(path: string) {
  const res = await fetch(SUPABASE_URL+'/rest/v1/'+path, {
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': 'Bearer '+SERVICE_KEY,
    }
  })
  return res.json()
}

Deno.serve(async (req) => {
  const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
  const authHeader  = req.headers.get('Authorization') ?? ''
  if (!CRON_SECRET || authHeader !== 'Bearer '+CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const weekKey = getMondayKey()
    console.log('Semaine: '+weekKey)
    const volunteers = await query('people?type=eq.vol&active=eq.true&email=not.is.null&select=name,email')
    console.log('Benevoles: '+volunteers.length)
    const submitted = await query('availabilities?week_key=eq.'+weekKey+'&select=person_name')
    const submittedNames = new Set(submitted.map((a: any) => a.person_name))
    const toRemind = volunteers.filter((v: any) => !submittedNames.has(v.name))
    console.log('A relancer: '+toRemind.length)
    const results = []
    for (const v of toRemind) {
      await delay(300)
      const result = await (async () => {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer '+RESEND_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Terrasse Cafe <onboarding@resend.dev>',
            to: v.email,
            subject: 'Disponibilites semaine du '+weekKey+' - Terrasse Cafe',
            html: buildEmailHtml(v.name, weekKey, APP_URL),
          }),
        })
        if (!res.ok) throw new Error(v.name+': '+await res.text())
        console.log('OK '+v.name)
        return v.name
      })().then(val => ({status: 'fulfilled', value: val})).catch(err => ({status: 'rejected', reason: err}))
      results.push(result)
    }
    const sent = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').map((r: any) => r.reason?.message)
    return new Response(JSON.stringify({weekKey, sent, skipped: submittedNames.size, failed}), {headers: {'Content-Type': 'application/json'}})
  } catch(err) {
    console.error('Erreur: '+err)
    return new Response(JSON.stringify({error: String(err)}), {status: 500})
  }
})