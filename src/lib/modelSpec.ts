// Options for describing a fashion model, turned into a FASHN model-create prompt.

export const OPTIONS = {
  gender: ['woman', 'man'],
  age: ['early 20s', 'late 20s', '30s', '40s', '50s', '60s'],
  skin: ['fair', 'light', 'olive', 'tan', 'brown', 'deep brown'],
  hairColor: ['black', 'dark brown', 'light brown', 'blonde', 'red', 'grey'],
  hairLength: ['short', 'shoulder-length', 'long', 'buzz cut', 'curly'],
  body: ['slim', 'average', 'athletic', 'curvy', 'plus-size'],
  pose: [
    'standing straight facing the camera, arms relaxed',
    'standing in a relaxed three-quarter pose',
    'standing with one hand in pocket',
    'mid-stride walking towards the camera',
  ],
  shot: ['full body', 'waist up'],
} as const

export type ModelSpec = { [K in keyof typeof OPTIONS]: (typeof OPTIONS)[K][number] } & { extra: string }

export const POSE_LABELS: Record<ModelSpec['pose'], string> = {
  'standing straight facing the camera, arms relaxed': 'Front',
  'standing in a relaxed three-quarter pose': 'Three-quarter',
  'standing with one hand in pocket': 'Hand in pocket',
  'mid-stride walking towards the camera': 'Walking',
}

export const DEFAULT_SPEC: ModelSpec = {
  gender: 'woman',
  age: 'late 20s',
  skin: 'light',
  hairColor: 'dark brown',
  hairLength: 'long',
  body: 'slim',
  pose: 'standing straight facing the camera, arms relaxed',
  shot: 'full body',
  extra: '',
}

export function buildPrompt(s: ModelSpec): string {
  const hair = s.hairLength === 'buzz cut' ? 'a buzz cut' : `${s.hairLength} ${s.hairColor} hair`
  const framing =
    s.shot === 'full body'
      ? 'Full body shot, the whole figure visible from head to feet with space above and below'
      : 'Waist-up shot, framed from the top of the head to the hips'
  // Plain, fitted base clothes make it easier for try-on to replace them with the real garment.
  const outfit = 'wearing a plain fitted white t-shirt and slim black trousers, simple white sneakers'
  return [
    `${framing}. Fashion e-commerce photo of a ${s.body} ${s.gender} in ${s.gender === 'woman' ? 'her' : 'his'} ${s.age} with ${s.skin} skin and ${hair}, ${s.pose}, ${outfit}.`,
    s.extra.trim(),
    'Plain light grey seamless studio backdrop, soft even studio lighting, sharp focus, natural skin texture.',
  ]
    .filter(Boolean)
    .join(' ')
}
