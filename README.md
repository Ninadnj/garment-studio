# Garment Studio

Live at **https://ninadnj.github.io/garment-studio/** (see [Install on a device](#install-on-a-device)).

Web app (installable on phones and Macs) for clothing photos:

1. **Clean photos.** Add one or many garment photos at once. Each background is removed on the device and replaced with a colour you pick (or a transparent PNG).
   - Edge cleanup: soft edges are recoloured with the garment's own colour, so the old background doesn't show as a light or dark rim. Specks and haze away from the garment are removed.
   - **The cutout is checked for you.** When the result is probably wrong (almost nothing kept, nothing removed, see-through areas, several separate pieces) a line under the photo says so and offers the three ways out: try another way, fix by hand, or "It is fine". A dark, blurry or small photo gets one line too, since the app cannot repair those.
   - **Try another way** shows the same photo cut out by the other methods, side by side on your background; tap the cleaner one. Two run on the device; the third, BiRefNet, is online: it sends that one photo to a free Hugging Face service and answers in a few seconds (a few free tries a day).
   - **Fix by hand**: a brush with zoom (pinch, ⌘-scroll, +/−), undo and redo, for what the remover gets wrong (a hand holding a label, a dropped sleeve).
   - **Fix light**: one tap brightens a dim photo and removes a yellow or blue colour cast, both read from the photo's plain white or grey background. It stays moderate (at most 0.7 of a stop brighter and half the Warmth slider, since a grey or cream wall can't be told from a white one in poor light), changes nothing when there is no such background or the background is kept, and can be undone.
   - **Remove background** can be switched off for close-ups (labels, fabric) where there is no background to remove.
   - **Light and colour** per photo: brightness, contrast, saturation, warmth. They change the garment only, never the background.
   - **Look**, shared by every photo: background colour, studio light, format (Square 1:1, Feed 4:5, 3:4, Story 9:16), margin, and a shadow (soft, close or floor).
   - Phone screenshots of a photo viewer are cropped to the photo first (status bar, buttons and page dots go).
   - Exports at 2048 px. **Save all** opens the share sheet with every photo on a phone ("Save Images" puts them in Photos); on a Mac it downloads one zip.
   - Every photo stays in the strip under the preview, on this device, until you delete it.
2. **On a model.** Create AI fashion models (gender, age, skin tone, hair, body, pose, framing) or upload a photo of a person, then put the garment on the chosen model. The result can be shown on the same background colour.
3. **Products.** A catalogue for selling: each product has a name, price (in the shop currency from Settings), code, status (draft, for sale, reserved, sold), sizes with stock, colours, category, condition, brand, material, measurements and notes. Garment photos belong to a product (one is the cover), and try-on results made while a photo belongs to the product are listed with it.
   - In the Studio, “Make a product” turns the photo on screen into a product; “Add to a product” adds it to an existing one.
   - The Products tab searches name, code, brand, category, colour, size, material, condition, measurements, notes, where it is posted and who it is reserved for (all words must match), and filters by status (Available = for sale or reserved), size in stock and who it is for. Sold products count as nothing in stock.
   - “Copy details” copies the facts for a post or a listing: name, your own *Words for posts*, price, sizes in stock, colour, brand, material, condition, measurements, code, then the shop's own lines from Settings. Notes stay private. Prices are written the Georgian way on every phone: `45 ₾`, `12 500 ₾`, `12,50 ₾`.
   - Products are kept on the device (IndexedDB, version 3) and can be shared with a team (see **Team** below).
4. **Post kit** (on a product): images made from its photos with the shop's Look (background, light, margin, shadow), each set handed to the share sheet with the details copied as the caption (Instagram and Facebook drop shared text, so it is pasted into the post). On a computer they are downloaded instead.
   - **Instagram post**, 1080 × 1350: photos in the order you tap them (cover first, then try-ons, then other photos; up to 10, the most an Android share sheet takes at once). The first can carry the price (sale price with the old one struck through and the discount), sizes in stock and code, kept inside the profile grid's 3:4 crop.
   - **Instagram story**, 1080 × 1920: one photo (a try-on when there is one) with the same facts, kept out of the top bar and the reply bar.
   - **Facebook and marketplaces**, 2048 × 2048, no text (marketplaces show the price in their own fields).
   - Sharing the post or story from a phone ticks Instagram under *Posted on* (with Undo); the other places are ticked by hand in the kit.
   - A try-on that still has the background it was made with can be cut out to the shop background from the kit.
5. **Catalogue** (Products tab): the products shown, as far as they can be sold now (for sale, in stock in the chosen size, with a photo; the rest is listed as left out), on 1080 × 1920 pages of 4 or 6 with photo (garment or try-on), price, code, name and sizes (the chosen size highlighted), the shop name and title at the top and the contact line at the bottom (Settings → Shop). Shared as images (in groups of 10 pages on a phone) or as one PDF, which messengers send unchanged as a document.
6. **Library.** Every try-on result is kept on the device.

Mac shortcuts: ⌘V pastes photos, ← → switch photos, E opens the brush. In the brush: E / R switch tools, [ ] change the brush size, ⌘Z / ⇧⌘Z undo and redo, 0 fits the photo, Space-drag moves around, Enter applies.

## How it works

| Part | Runs where | Cost |
|---|---|---|
| Background removal (default) | In the browser: [BRIA RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) via onnxruntime-web (WebGPU, falls back to WASM). The 88 MB model downloads once into Cache Storage. About 0.5 s per photo on an M2 once cached; about 8 s on the WASM fallback. | Free |
| Background removal (second method) | [@imgly/background-removal](https://github.com/imgly/background-removal-js) (ISNet), under *Try another way*, or as the default in Settings. Loaded only when picked. | Free |
| Background removal (online) | [BiRefNet](https://huggingface.co/spaces/ZhengPeng7/BiRefNet_demo) on its author's Hugging Face Space (shared GPU), only when asked for under *Try another way*: the photo is uploaded, the cutout comes back in 3–4 s and gets the same edge cleanup. It is saved like a hand fix, so teammates receive the cutout itself. | Free, a few tries a day |
| Photo check, cutout check, Fix light | In the browser, on small copies of the photo and its cutout: `src/lib/photocheck.ts`, `cutcheck.ts`, `autofix.ts` (thresholds and what they were measured on are in the files). | Free |
| Edge cleanup | In a Web Worker: blur-fusion foreground estimation ([Forte & Pitié 2021](https://github.com/Photoroom/fast-foreground-estimation)) recolours soft edge pixels; connected regions under 0.5 % of the garment are dropped. `src/lib/matte/`. | Free |
| HEIC photos (iPhone/Mac) | Converted to JPEG in the browser when the browser can't read HEIC ([heic-to](https://github.com/hoppergee/heic-to)). | Free |
| AI, free service (default) | Public Hugging Face Spaces, called from the browser over Gradio's queue API (`src/lib/hf.ts`). Tops and dresses with [Kolors Virtual Try-On](https://huggingface.co/spaces/Kwai-Kolors/Kolors-Virtual-Try-On), which passes the images on to Kuaishou's servers. Bottoms with [WeShop's try-on demo](https://huggingface.co/spaces/WeShopAI/WeShopAI-Virtual-Try-On), which passes the images on to WeShop's servers. New models with [HiDream-O1-Image](https://huggingface.co/spaces/HiDream-ai/HiDream-O1-Image), else [HiDream-I1-Dev](https://huggingface.co/spaces/HiDream-ai/HiDream-I1-Dev), which pass the prompt on to HiDream's servers. Backups on the shared GPUs, when one of those is busy: tops with [IDM-VTON](https://huggingface.co/spaces/yisol/IDM-VTON), bottoms and dresses with [Leffa](https://huggingface.co/spaces/franciszzj/Leffa), new models with [FLUX.1 dev](https://huggingface.co/spaces/black-forest-labs/FLUX.1-dev). About 15–50 s per image; try-on results about 768 × 1024 (WeShop 1520 × 2048), kept as JPEG; models stored at up to 2048 px. | Free: Kolors, WeShop and HiDream without a daily limit, the shared GPUs about 3 images a day |
| AI, FASHN | [FASHN](https://docs.fashn.ai) `model-create` and `tryon-max` (keeps the model's pose and framing), up to 4k. | FASHN credits |

**Background removers compared** (2026-11-10, 12 photos: 8 product shots on white, 4 of people; M2 Mac, Chrome). BRIA RMBG-1.4 cut out all 12 correctly, in under 1 s each on WebGPU. IMG.LY's ISNet got 9 right: it kept only the button band of a grey cardigan, only the print of a cream top, and left a patterned skirt half transparent. Open RMBG (Apache-2.0) got 11 right, left the cream top half transparent, and runs on WASM only: 9 s a photo. BiRefNet lite (MIT) does not run with onnxruntime-web 1.21. BiRefNet online cut out the two hardest photos (cream top, grey cardigan) cleanly. So BRIA stays the default, IMG.LY the second method on the device, and BiRefNet the online one; no remover that is free for commercial use matched BRIA on the device.

**Kolors** (tested 2026-10-30) runs on Kuaishou's servers, not on the shared GPUs, so the limits below don't apply to it. When many people use it, it answers "Too many users, please try again later", and the app sends the try-on to IDM-VTON or Leffa instead (the progress line names the service). It doesn't do bottoms: a test pair of jeans came back as a dress. In tests, small print on garments came out garbled, and a long top sometimes changed what the model wears below. The garment type (top, bottom, dress) is kept with each photo, because it decides which service gets it.

**WeShop** (tested 2026-10-31) does the bottoms the same way, on WeShop's servers, with no login and no per-user limit in its code; it receives the photos and the connection's IP address. About 45–50 s per image. In 1 of 3 tests it added a jacket nobody asked for, so some results need another try. It reports problems only as a warning next to an empty result; the app counts that as a failure, sends the try-on to Leffa, and shows the warning only if Leffa fails too.

Kolors, WeShop and HiDream get 5 minutes per image (HiDream's two demos share them) before the backup takes over. Only the first output image is downloaded; the Hugging Face token goes only to the shared-GPU Spaces themselves. Person photos are re-encoded before they are stored or sent, which drops their metadata (where and when they were taken).

**Privacy of the free services:** Kolors' demo passes the photos on to Kuaishou over plain http (its public code shows this). WeShop's demo forwards your IP address with the photos.

**HiDream** (tested 2026-10-31) works the same way for new models: its demos run on HiDream's servers, with no login and no per-user limit in their code. About 35–50 s per image; O1 returns 1728 × 2304, I1 880 × 1168. When both fail, FLUX.1 dev takes over. Only the shared-GPU Spaces receive the Hugging Face token.

**Free limits** (checked 2026-10-30): Hugging Face limits free use of its shared GPUs ("ZeroGPU") in two ways.
- **GPU time per day** ([docs](https://huggingface.co/docs/hub/spaces-zerogpu)): 2 minutes without an account, counted per internet connection; 5 minutes with a free account; 40 minutes with PRO ($9 a month). It renews 24 hours after the first use. Each image reserves 60–90 s up front, so 2 minutes often covers only 2 images.
- **Runs per day:** about 3 for free users since April 2026 ([Hugging Face staff on the forum](https://discuss.huggingface.co/t/free-account-zerogpu-quota-issue/175180/9)). The error ("You have exceeded your ZeroGPU runs limit") gives no renewal time.

To use your own account's allowance, create a "Read" token at huggingface.co/settings/tokens and paste it in **Settings**. A PRO account's token gets PRO's allowance. When a limit runs out, the app says which one and when it renews. Hugging Face gives the time only for the GPU-time limit, so the app remembers the last time it was given.

FASHN credits per image: fast 1/2/3, balanced 2/3/4, quality 3/4/5 for 1k/2k/4k.

Keys (FASHN API key, Hugging Face token) are entered in **Settings** and stored only in that browser's `localStorage`. Photos, models and results live in IndexedDB on the device.

## Team (shared catalogue)

Products, the photos in them and their try-on results can be shared with a small team through a free [Supabase](https://supabase.com) project. Models and photos outside a product stay on each device, and each device makes its own cutouts. The app talks to Supabase's HTTP API directly (`src/lib/team.ts`, `src/lib/sync.ts`); there is no server of our own.

**Setup, once (about 10 minutes):**
1. Create a free account at supabase.com and a new project (a region near you, e.g. Frankfurt). Keep the database password it shows somewhere safe; the app doesn't need it.
2. **SQL Editor** → New query → paste all of `supabase/setup.sql` → Run. It creates the shared table and the private `photos` bucket, and lets only signed-in team members read or write them (including the explicit table grant Supabase requires for new tables since October 2026). Running it again is harmless; a project set up before 9 November 2026 should run it once more (it then also stops a phone whose clock runs ahead from blocking the team's later edits).
3. **Authentication → Sign In / Providers**: turn off *Allow new users to sign up*, so only people you add can sign in. While it is on, anyone who learns the project address could create an account and see the catalogue; the Team section in Settings says so.
4. **Authentication → Users → Add user → Create new user**, for each team member: email and password, with *Auto Confirm User* ticked. No email is sent.
5. **Project Settings → API Keys**: copy the project URL and the *publishable* (anon) key. Never put the secret (service_role) key in the app.
6. In the app: **Settings → Team** → paste both → Connect → sign in.
7. **Settings → Team → Copy link for your team**, and send it to the others. Each of them opens the app, pastes the link into **Settings → Team → Project URL** → Connect, and signs in with their own account. (Opening the link also connects, but only in the browser it opens in; see [Install on a device](#install-on-a-device).) The app only accepts links to an `https://….supabase.co` project, and opening a link to another project signs out first.

**How it works:** every change on a device is queued and uploaded a few seconds later; each device also fetches the team's changes every 30 seconds while the app is open, when it comes back online, and with *Sync now*. Of two versions of a record, the one changed later wins: the database refuses an older upload, and the device then takes the team's version. Automatic cutouts and thumbnails are made by each device and are not edits. Deleting a product, or taking a photo out of its product, removes it from the team; the photo stays on the device it was taken out on. Photos are stored under names made from their content, so an unchanged photo is never uploaded twice. Sync never deletes photos from storage (another device's version may still use one), so replaced and deleted photos keep counting toward the 1 GB. A change whose photo fails to download is tried again on the next sync; the rest is applied meanwhile.

*Sign out* ends the session on this device only. When the free project is paused, the app says so and keeps the session; restore the project in the dashboard and sync carries on.

**Free plan limits** (supabase.com/pricing, checked 2026-11-01): 1 GB of files (about 2,000 products with one photo and one try-on result), 500 MB database, 5 GB of downloads a month (a new device downloads the whole catalogue once), 50,000 users a month. A free project **pauses after a week without use**; resume it from the Supabase dashboard. There are no automatic backups on the free plan.

**The team's phones** need the app at an HTTPS address (see Deploy); a dev server on a Mac can only be opened on that Mac.

## Develop

```bash
npm install
npm run dev
npm test
```

`test-fixtures/` holds synthetic test images (a T-shirt photo in JPEG and HEIC, a stand-in model photo). Unit tests cover the edge cleanup, light and colour, the zip writer, settings migration, products (codes, stock, prices as typed, search, size order, copied details), team sync (two devices against a stand-in for Supabase: sharing, newer-wins, deletions, photos uploaded once), the Supabase client (sign-in, session renewal, paging, request formats, setup links pasted with other text, secret keys refused), the post kit and catalogue (photo order, facts on images, prices, text fitting with Georgian names, safe areas, page layout, what a catalogue leaves out, the PDF's structure), and the Hugging Face client: message parsing, which service each free try-on and new model goes to, the backups and their messages, and that only the shared-GPU Spaces get the token (against a stand-in for the Spaces, so no requests go out).

## Deploy

`.github/workflows/deploy.yml` builds and publishes `dist/` to GitHub Pages on every push to `main` (Settings → Pages → Source: GitHub Actions). The build uses relative paths, so it works under any sub-path.

Browser storage belongs to the origin, not the path: as a project site under `ninadnj.github.io`, the app shares its keys (Settings), its team sign-in (Supabase session) and photos (IndexedDB) with every other Pages site on that account, so those sites should load no scripts from elsewhere. A custom subdomain (a CNAME on its Pages site) or another host keeps them apart.

## Install on a device

- **iPhone:** open the site in Safari → Share → Add to Home Screen.
- **Android:** open the site in Chrome → ⋮ → Add to Home screen (or Install app).
- **Mac:** Safari → File → Add to Dock, or the install icon in Chrome's address bar.

An app added to the iPhone Home Screen, or to the Dock from Safari, keeps its own storage apart from Safari: it starts empty, and a setup link opened in Safari doesn't reach it, so paste the link into its **Settings → Team** instead. An app installed from Chrome shares Chrome's storage. Links opened inside Instagram, Facebook or WhatsApp open in their own browser, with its own storage too.

## Licences

This is a personal, non-commercial app. Every component below allows that, except WeShop's demo, which states no terms:

- BRIA RMBG-1.4 weights: free for non-commercial use only (commercial use needs an agreement with BRIA).
- BiRefNet (the online remover): MIT.
- `@imgly/background-removal`: AGPL-3.0 (keep the source public if the app is served to others).
- `heic-to`: LGPL-3.0.
- Free AI service: IDM-VTON (CC BY-NC-SA 4.0) and FLUX.1 dev (FLUX.1 [dev] Non-Commercial License) are non-commercial; Leffa is MIT. Kolors Virtual Try-On is a hosted demo (the Space's code is Apache-2.0; the try-on runs on Kuaishou's servers). The HiDream demos are hosted too (their Spaces' code is MIT; the images are made on HiDream's servers), and so is WeShop's (the try-on runs on WeShop's servers; its Space gives its licence only as "other", with no terms).

Local experiments (a local CatVTON try-on, a background-remover comparison) live in `local-tryon/`, which is not in the repository; none of it is part of the app.
