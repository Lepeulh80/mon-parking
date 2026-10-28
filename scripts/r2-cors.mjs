// Autorise le navigateur de l'application à déposer dans le bucket. À lancer
// une seule fois après création du bucket : npm run r2:cors
import { createR2 } from '../server/r2.mjs'

const media = createR2()
if (!media) { console.error('R2 non configuré : R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET requis.'); process.exit(1) }
const origins = [process.env.AUTH_ORIGIN || 'https://mon-parking.onrender.com']
console.log('CORS appliqué pour :', await media.cors(origins))
media.close()
