const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

// ====== CONFIG ENV ======
const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const GOOGLE_SHEETS_SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

if (!SPREADSHEET_ID) {
  console.error('❌ GOOGLE_SHEETS_SPREADSHEET_ID manquant dans les variables d’environnement.');
  process.exit(1);
}
if (!SERVICE_ACCOUNT_KEY) {
  console.error('❌ GOOGLE_SERVICE_ACCOUNT_KEY manquant dans les variables d’environnement.');
  process.exit(1);
}

// On parse le JSON du compte de service
let creds;
try {
  creds = JSON.parse(SERVICE_ACCOUNT_KEY);
} catch (err) {
  console.error('❌ Impossible de parser GOOGLE_SERVICE_ACCOUNT_KEY comme JSON :', err);
  process.exit(1);
}

// Certains hébergeurs stockent la clé privée avec les "\n" échappés
const privateKey = creds.private_key.replace(/\\n/g, '\n');

// Auth Google
const auth = new google.auth.JWT(
  creds.client_email,
  null,
  privateKey,
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

// ====== EXPRESS APP ======
const app = express();

// CORS : en dev on autorise tout, en prod tu pourras restreindre à ton domaine Pressero
app.use(cors());
app.use(express.json());

// Crée l'onglet pour cet email s'il n'existe pas encore
async function ensureSheetExists(sheetName) {
  // 1) Récupérer la liste des onglets
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID
  });

  const already = (meta.data.sheets || []).find(s =>
    s.properties && s.properties.title === sheetName
  );

  if (already) {
    // L'onglet existe déjà → rien à faire
    return;
  }

  console.log(`[KITS] Création de l’onglet "${sheetName}"`);

  // 2) Créer le nouvel onglet
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: sheetName
            }
          }
        }
      ]
    }
  });

  // 3) Poser la ligne d'en-têtes (A1:S1)
await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: `'${sheetName}'!A1:S1`,   // <-- A → S (19 colonnes)
  valueInputOption: 'RAW',
  requestBody: {
    values: [[
      'KitId',
      'KitName',
      'ImageURL',
      'DefaultQtyLivret',
      'DefaultQtyPochette',
      'DefaultQtyPatron',
      'NombrePagesLivret',
      'TypeLivret',
      'TypeImpressionCouverture',
      'TypeImpressionCorps',
      'PapierCouverture',
      'PapierCorps',
      'FormatFermeLivret',
      'Pochette',
      'MiseEnPochette',
      'PatronM2',
      'ImpressionPatron',
      'Active',
      'PJMOptionsJSON'
    ]]
  }
});


  console.log(`[KITS] En-têtes initialisés pour "${sheetName}"`);
}


// Petite aide : convertion "1,2" -> nombre
function parseNumberFromSheet(value) {
  if (value == null) return 0;
  const v = String(value).trim().replace(',', '.');
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// ===================== ROUTES ADMIN KITS =====================

// GET /admin/kits?email=xxx
// - Crée l’onglet pour cet email si besoin (avec les en-têtes)
// - Lit toutes les lignes et renvoie la liste des kits
app.get('/admin/kits', async (req, res) => {
  const rawEmail = (req.query.email || '').trim();
  const email = rawEmail.toLowerCase();

  if (!email) {
    return res.status(400).json({ error: 'Missing email' });
  }

  try {
    // On réutilise la logique d’onglet + en-têtes
    const sheetName = email;
    await ensureSheetExists(sheetName); // ta fonction existe déjà plus haut

    // ⚠️ adapte la plage en fonction de ton nombre de colonnes
    // Ici A → S (19 colonnes, index 0..18)
    const range = `'${sheetName}'!A2:S`;

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
      range
    });

    const rows = resp.data.values || [];

    const kits = rows
      .filter(r => r && r.length > 0)
      .map((row, index) => {
        return {
          // Infos techniques
          rowIndex: index + 2,           // ligne dans Google Sheet
          sheetName,

          // Mapping colonnes (ordre = header que tu as défini)
          kitId:                row[0]  || '',
          kitName:              row[1]  || '',
          imageUrl:             row[2]  || '',
          defaultQtyLivret:     row[3]  || '',
          defaultQtyPochette:   row[4]  || '',
          defaultQtyPatron:     row[5]  || '',
          nombrePagesLivret:    row[6]  || '',
          typeLivret:           row[7]  || '',
          typeImpressionCouv:   row[8]  || '',
          typeImpressionCorps:  row[9]  || '',
          papierCouverture:     row[10] || '',
          papierCorps:          row[11] || '',
          formatFermeLivret:    row[12] || '',
          pochette:             row[13] || '',
          miseEnPochette:       row[14] || '',
          patronM2:             row[15] || '',
          impressionPatron:     row[16] || '',
          activeRaw:            row[17] || '',
          pjmOptionsJson:       row[18] || ''
        };
      });

    return res.json({
      email,
      sheetName,
      count: kits.length,
      kits
    });
  } catch (err) {
    console.error('[ADMIN /admin/kits] Error:', err);
    return res.status(500).json({
      error: 'Internal error while reading kits',
      details: err.message
    });
  }
});


// Endpoint de test
app.get('/health', (req, res) => {
  res.json({ status: 'ok', spreadsheetId: SPREADSHEET_ID });
});

// GET /kits?email=...
app.get('/kits', async (req, res) => {
  const email = (req.query.email || '').trim();
  if (!email) {
    return res.status(400).json({ error: 'Missing email query parameter' });
  }

  // Hypothèse actuelle : le nom de l’onglet = l’email du client
  // (ex : onglet "client1@test.com"). On pourra faire un mapping plus tard.
  const sheetName = email;

  // Plage : en-têtes en ligne 1, data à partir de A2:J (KitId .. Active)
  const range = `'${sheetName}'!A2:S`;

  try {
    // Crée l'onglet + en-têtes s'il n'existe pas encore
    await ensureSheetExists(sheetName);

    // Puis on lit les lignes de données
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range
    });

    const rows = response.data.values || [];

    // Map chaque ligne -> objet
    const kits = rows
  .filter(row => row && row.length > 0)
  .map(row => {
    const [
      kitId,
      kitName,
      imageUrl,
      defaultQtyLivretRaw,
      defaultQtyPochetteRaw,
      defaultQtyPatronRaw,
      nombrePagesLivret,
      typeLivret,
      typeImpressionCouverture,
      typeImpressionCorps,
      papierCouverture,
      papierCorps,
      formatFermeLivret,
      pochette,
      miseEnPochette,
      patronM2,
      impressionPatron,
      activeFlag,
      pjmOptionsJson
    ] = row;

    const defaultQtyLivret   = parseNumberFromSheet(defaultQtyLivretRaw);
    const defaultQtyPochette = parseNumberFromSheet(defaultQtyPochetteRaw);
    const defaultQtyPatron   = parseNumberFromSheet(defaultQtyPatronRaw);

    // Par défaut : actif sauf si explicitement "non", "no", "0", "false"
    const activeRaw = (activeFlag || '').toString().trim().toLowerCase();
    const isActive = !['non', 'no', '0', 'false'].includes(activeRaw);

    // Parsing éventuel du JSON PJMOptionsJSON (facultatif pour l’instant)
    let pjmOptions = null;
    if (pjmOptionsJson && typeof pjmOptionsJson === 'string') {
      try {
        pjmOptions = JSON.parse(pjmOptionsJson);
      } catch (e) {
        console.warn('[KITS] PJMOptionsJSON invalide pour le kit', kitId, e.message);
      }
    }

    return {
      kitId: kitId || '',
      name: kitName || '',
      imageUrl: imageUrl || '',
      defaultQtyLivret,
      defaultQtyPochette,
      defaultQtyPatron,

      // Placeholders pour l’UI actuelle (on mettra le vrai prix via PJM plus tard)
      priceLivret: 0,
      pricePochette: 0,
      pricePatron: 0,

      active: isActive,

      // On garde toute la config métier accessible si on en a besoin plus tard
      config: {
        nombrePagesLivret: nombrePagesLivret || '',
        typeLivret: typeLivret || '',
        typeImpressionCouverture: typeImpressionCouverture || '',
        typeImpressionCorps: typeImpressionCorps || '',
        papierCouverture: papierCouverture || '',
        papierCorps: papierCorps || '',
        formatFermeLivret: formatFermeLivret || '',
        pochette: pochette || '',
        miseEnPochette: miseEnPochette || '',
        patronM2: patronM2 || '',
        impressionPatron: impressionPatron || ''
      },

      pjmOptions
    };
  })
  .filter(kit => kit.active);


    res.json({
      email,
      sheetName,
      count: kits.length,
      kits
    });
  } catch (err) {
    console.error('❌ Erreur lors de la lecture du sheet pour', sheetName, err.message);

    
    res.status(500).json({
      error: 'Error reading Google Sheet',
      details: err.message || String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ kits-couture-api listening on port ${PORT}`);
});
