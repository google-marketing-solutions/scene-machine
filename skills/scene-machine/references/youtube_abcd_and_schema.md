# YouTube ABCD Creative Framework and Storyboard JSON Schema (v2.1)

This reference defines the creative dramaturgy, the 3-layer Image-to-Video
(I2V) motion prompt structure and the canonical `storyboard.json` contract
shared by `scripts/generate_ad_spot_vertex.py` (generation) and
`scripts/assemble_ad_video.py` (assembly). Two complete authoring examples
live in `assets/examples/storyboard_5x6.json` (30 s) and
`assets/examples/storyboard_3x6.json` (18 s).

---

## 1. YouTube ABCD Scene Architecture

Every commercial spot follows the public YouTube ABCD creative principles
(Attract, Brand, Connect, Direct) with visual bookending between the opening
and closing shots:

| Scene | Window (30 s default) | ABCD Pillar | Creative and Visual Role |
| :--- | :--- | :--- | :--- |
| Scene 1 | `0.0s - 6.0s` | Attract | Immediate visual hook in the first 3 seconds; establishes the signature lighting motif and primary brand colour accent. |
| Scene 2 | `6.0s - 12.0s` | Brand | Introduces the product or service naturally in action within a recognisable context. |
| Scene 3 | `12.0s - 18.0s` | Connect | Relatable human or customer scenario showing real-world emotional resonance and benefit. |
| Scene 4 | `18.0s - 24.0s` | Connect (Proof) | Feature demonstration, transformation, or a clear visual proof point / KPI infographic. |
| Scene 5 | `24.0s - 30.0s` | Direct and Bookend | Echoes the lighting and colour motif of Scene 1 (`24.0s - 27.0s`), then settles (`27.0s - 30.0s`) into the high-contrast branded endcard and call to action (CTA). |

Shots are 6 seconds by default; 4 and 8 second shots are allowed (Veo 3.1
clip lengths) when the brief needs a faster hook or a longer hero. Two to six
shots are supported; `totalDurationSeconds` is always the sum of the shots.

### Compact 3-Scene Mode (`18.0s` - Quota-Saving Variant)

When the user requests a shorter bumper or spot (or when video generation
quotas are constrained), condense into 3 scenes (`3 x 6.0s = 18.0s`):

1. Scene 1 (`0.0s - 6.0s` - Attract + Brand): immediate visual hook with the
   product introduction.
2. Scene 2 (`6.0s - 12.0s` - Connect + Proof): customer benefit and key value
   demonstration.
3. Scene 3 (`12.0s - 18.0s` - Direct and Bookend): hero callback transitioning
   at `15.0s - 18.0s` into the branded CTA endcard.

---

## 2. Keyframe Prompt Rules (Text-to-Image)

1. Clean, unobstructed cinema frames (zero baked-in copy):
   - Image diffusion models frequently misspell multi-word slogans or invent
     fake UI buttons (`SHOP NOW`) when marketing copy is part of the visual
     prompt.
   - Keep headlines, lower-thirds and URLs out of keyframe prompts; pass them
     in `typoOverlay` and `endcardSpec` so `scripts/assemble_ad_video.py`
     renders crisp, editable brand typography.
   - Always append: `"Clean commercial cinema frame with no overlaid UI text,
     buttons, subtitles, or watermarks."`
2. Data-driven infographic keyframes (exception for quantitative metrics):
   - When a scene visualises concrete metrics supplied by the user
     (percentages, growth multiples, revenue figures), begin the image prompt
     with `"Generate a clean executive infographic visualizing ..."` and list
     only the exact verified numbers and short labels.
3. Brand palette continuity:
   - Thread the four `brandPalette` hex codes (`backgroundHex`,
     `primaryAccentHex`, `secondaryAccentHex`, `textLightHex`) into lighting,
     wardrobe, props and environmental accents across all scenes.

---

## 3. 3-Layer Image-to-Video (I2V) Motion Prompt Formula

To prevent subject morphing, facial drift or geometry warping during
generative video animation, structure every `motionPrompt` with three
explicit clauses:

1. `[VISUAL ANCHOR LOCK]`: enumerate the immutable foreground, midground and
   background elements from the keyframe (faces, posture, product shape,
   materials, wardrobe colours, room architecture) that must remain intact.
2. `[CAMERA TRAJECTORY]`: choose one disciplined 3D camera movement per clip:
   - `Slow Dolly Push-In`
   - `Smooth Orbital Pan`
   - `2.5D Lateral Parallax Glide`
   - `Gentle Crane-Up Reveal`
   - `Controlled Pull-Back`
   - `Stable Locked Hero Frame` (recommended for the final endcard shot)
3. `[LIGHTING & MICRO-PHYSICS]`: describe subtle, physically plausible
   environmental motion (warm sunlight shifting across stone, soft fabric
   breeze, shallow depth-of-field bokeh, a natural facial expression shift).
   Never request fast cuts, camera shake or overlaid text inside one clip.

---

## 4. Canonical `storyboard.json` Schema (v2.1)

`scripts/generate_ad_spot_vertex.py` validates this contract before any call
(exit 5 with `invalid_storyboard` otherwise) and `scripts/assemble_ad_video.py`
reads it to normalise clips, render lower-thirds and the CTA endcard, mix
voiceover and music, normalise loudness to `-14.0 LUFS` and export the
deliverables.

Changes from v2.0: `shots` allows 2 to 6 entries; `shots[].durationSeconds`
is 4, 6 or 8; `language` is a BCP-47 tag used for TTS; `audioSpec.musicPrompt`
must be English and ASCII; `audioSpec.duckingMode` is new and optional;
`typoOverlay.headline` and `subtext` may be `null`; the file keys are marked
as generated. Square output is documented as `exportSquareCrop` on a `9:16`
storyboard (a centre crop); `aspectRatio: "1:1"` is rejected with that hint.

Authoring checklist (what the dry-run checks): 2-6 shots with unique
`shotIndex`, non-empty `visualPrompt` and `motionPrompt`, `durationSeconds`
in 4/6/8, `aspectRatio` 16:9 or 9:16, `language` as a BCP-47 tag, a 50-65
word `voiceoverScript` (count it with a word split), an ASCII English
`musicPrompt`, and no `clipFile`, `keyframeFile`, `voiceoverFile` or
`musicFile` keys: the generator fills those in.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "SceneMachineStoryboard",
  "description": "Storyboard contract v2.1 shared by generate_ad_spot_vertex.py and assemble_ad_video.py.",
  "type": "object",
  "required": ["brandName", "aspectRatio", "totalDurationSeconds", "shots"],
  "properties": {
    "brandName": { "type": "string" },
    "campaignTitle": { "type": "string" },
    "language": {
      "type": "string",
      "pattern": "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$",
      "default": "en-US",
      "description": "BCP-47 tag (en-US, de-DE); passed to the TTS language_code and used for the voiceover and headlines."
    },
    "aspectRatio": {
      "type": "string",
      "enum": ["16:9", "9:16"],
      "description": "Veo 3.1 renders only these two. Square output: set 9:16 and exportSquareCrop true."
    },
    "exportSquareCrop": {
      "type": "boolean",
      "default": false,
      "description": "With aspectRatio 9:16, also export final_video_1x1.mp4 as a centre crop of the 9:16 render. This is the only 1:1 path."
    },
    "totalDurationSeconds": {
      "type": "number",
      "minimum": 8,
      "maximum": 48,
      "description": "Sum of shots[].durationSeconds: 30 for 5 x 6 s, 18 for 3 x 6 s."
    },
    "brandPalette": {
      "type": "object",
      "required": ["backgroundHex", "primaryAccentHex", "secondaryAccentHex", "textLightHex"],
      "properties": {
        "backgroundHex": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
        "primaryAccentHex": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
        "secondaryAccentHex": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
        "textLightHex": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" }
      }
    },
    "endcardSpec": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean", "default": true },
        "durationSec": { "type": "number", "default": 3.0 },
        "headline": { "type": "string" },
        "subheadline": { "type": "string" },
        "ctaText": { "type": "string" },
        "ctaUrl": { "type": "string" }
      }
    },
    "audioSpec": {
      "type": "object",
      "properties": {
        "voiceoverScript": {
          "type": "string",
          "description": "50-65 words in the storyboard language (validated by the generator; --no-strict-copy downgrades to a warning)."
        },
        "musicPrompt": {
          "type": "string",
          "pattern": "^[ -~]+$",
          "description": "English (en-US) only and ASCII: lyria-002 accepts English prompts."
        },
        "duckingMode": {
          "type": "string",
          "enum": ["constant", "sidechain"],
          "default": "constant",
          "description": "Optional. constant lowers the music under the voiceover by musicDuckVolume; sidechain follows the voice level."
        },
        "musicDuckVolume": { "type": "number", "default": 0.28 },
        "targetLufs": { "type": "number", "default": -14.0 },
        "fadeOutSeconds": { "type": "number", "default": 1.5 },
        "musicFile": {
          "type": "string",
          "description": "Generated: written by the generator. Omit when authoring."
        },
        "voiceoverFile": {
          "type": "string",
          "description": "Generated: written by the generator. Omit when authoring."
        }
      }
    },
    "shots": {
      "type": "array",
      "minItems": 2,
      "maxItems": 6,
      "items": {
        "type": "object",
        "required": ["shotIndex", "abcdStage", "durationSeconds", "visualPrompt", "motionPrompt"],
        "properties": {
          "shotIndex": { "type": "integer", "minimum": 1, "maximum": 6 },
          "abcdStage": {
            "type": "string",
            "enum": ["Attract", "Brand", "Connect", "Proof", "Direct"]
          },
          "durationSeconds": {
            "type": "number",
            "enum": [4, 6, 8],
            "default": 6,
            "description": "Veo 3.1 clip length; passed through to the generator."
          },
          "visualPrompt": { "type": "string" },
          "motionPrompt": { "type": "string" },
          "voiceoverSegment": { "type": "string" },
          "typoOverlay": {
            "type": "object",
            "properties": {
              "headline": {
                "type": ["string", "null"]
              },
              "subtext": {
                "type": ["string", "null"]
              }
            }
          },
          "keyframeFile": {
            "type": "string",
            "description": "Generated: written by the generator. Omit when authoring."
          },
          "clipFile": {
            "type": "string",
            "description": "Generated: written by the generator; required by the assembler at render time."
          }
        }
      }
    }
  }
}
```

---

## 5. Worked Example (`storyboard.json`, resolved form)

NordicGlow is a fictional skincare brand used in every example. The file
keys (`keyframeFile`, `clipFile`, `musicFile`, `voiceoverFile`) show the
resolved form the generator writes to `<output-dir>/storyboard.json`; their
paths are relative to the storyboard file. Omit them when authoring. The
voiceover below has 57 words.

```json
{
  "brandName": "NordicGlow",
  "campaignTitle": "Radiant Renewal Launch (30 s, 5 x 6 s)",
  "language": "en-US",
  "aspectRatio": "16:9",
  "exportSquareCrop": false,
  "totalDurationSeconds": 30,
  "brandPalette": {
    "backgroundHex": "#0F172A",
    "primaryAccentHex": "#38BDF8",
    "secondaryAccentHex": "#F59E0B",
    "textLightHex": "#F8FAFC"
  },
  "endcardSpec": {
    "enabled": true,
    "durationSec": 3,
    "headline": "Reveal Your Natural Radiance",
    "subheadline": "NordicGlow Radiant Renewal Serum",
    "ctaText": "Discover More",
    "ctaUrl": "nordicglow.example"
  },
  "audioSpec": {
    "musicFile": "work/music_bed.wav",
    "voiceoverFile": "work/voiceover.wav",
    "voiceoverScript": "Cold mornings leave skin feeling tired and tight. Meet NordicGlow Radiant Renewal Serum, made with wild Arctic cloudberries and pure hyaluronic acid. One drop delivers deep, lasting hydration and restores a luminous, balanced glow in just twenty-four hours. Dermatologically tested, fragrance free, and gentle enough for every single morning. Reveal your natural radiance today, only with NordicGlow.",
    "musicPrompt": "Modern Scandinavian electronic ambient pop commercial soundtrack, warm synth arpeggios, crisp minimal percussion, uplifting harmonic build at 18 seconds, clean gentle resolution at 28 seconds, 112 BPM, instrumental.",
    "musicDuckVolume": 0.28,
    "targetLufs": -14,
    "fadeOutSeconds": 1.5
  },
  "shots": [
    {
      "shotIndex": 1,
      "abcdStage": "Attract",
      "durationSeconds": 6,
      "keyframeFile": "work/shot_1.png",
      "clipFile": "work/shot_1.mp4",
      "visualPrompt": "Cinematic macro photography of golden morning sunlight catching frosted Arctic cloudberries on dark slate (#0F172A) with subtle ice-blue (#38BDF8) rim reflections, shallow depth of field. Clean commercial cinema frame with no overlaid UI text, buttons, subtitles, or watermarks.",
      "motionPrompt": "[VISUAL ANCHOR LOCK] Frosted orange cloudberries resting on dark textured slate with glistening water droplets remain sharp and unchanged in geometry. [CAMERA TRAJECTORY] Slow Dolly Push-In toward the central berry cluster. [LIGHTING & MICRO-PHYSICS] Warm golden dawn light sweeps gently across frost crystals as a single dewdrop shimmers.",
      "voiceoverSegment": "Cold mornings leave skin feeling tired and tight.",
      "typoOverlay": {
        "headline": "Winter Skin Fatigue?",
        "subtext": "Harsh climates strip natural moisture"
      }
    },
    {
      "shotIndex": 2,
      "abcdStage": "Brand",
      "durationSeconds": 6,
      "keyframeFile": "work/shot_2.png",
      "clipFile": "work/shot_2.mp4",
      "visualPrompt": "Studio product photography of an amber glass dropper bottle on minimalist travertine stone against a soft slate (#0F172A) backdrop, warm amber (#F59E0B) caustics and soft ice-blue (#38BDF8) rim light. Clean commercial cinema frame with no overlaid UI text, buttons, subtitles, or watermarks.",
      "motionPrompt": "[VISUAL ANCHOR LOCK] Frosted amber glass serum bottle with metallic dropper cap on a travertine stone pedestal remains stationary and undistorted. [CAMERA TRAJECTORY] Smooth Orbital Pan 15 degrees right around the bottle. [LIGHTING & MICRO-PHYSICS] Golden sunlight caustics ripple subtly across the travertine surface.",
      "voiceoverSegment": "Meet NordicGlow Radiant Renewal Serum, made with wild Arctic cloudberries and pure hyaluronic acid.",
      "typoOverlay": {
        "headline": "NordicGlow Serum",
        "subtext": "Botanical Arctic Cloudberry Complex"
      }
    },
    {
      "shotIndex": 3,
      "abcdStage": "Connect",
      "durationSeconds": 6,
      "keyframeFile": "work/shot_3.png",
      "clipFile": "work/shot_3.mp4",
      "visualPrompt": "Editorial natural-light portrait of a smiling woman in a Scandinavian sunlit bathroom applying two golden serum drops to her cheek, warm morning light, soft slate and linen tones. Clean commercial cinema frame with no overlaid UI text, buttons, subtitles, or watermarks.",
      "motionPrompt": "[VISUAL ANCHOR LOCK] Woman in a cream knit sweater in a sunlit minimalist bathroom keeps consistent facial features, hair, and wardrobe. [CAMERA TRAJECTORY] 2.5D Lateral Parallax Glide tracking gently at eye level. [LIGHTING & MICRO-PHYSICS] Soft morning window light illuminates dewy skin as she smiles naturally.",
      "voiceoverSegment": "One drop delivers deep, lasting hydration and restores a luminous, balanced glow in just twenty-four hours.",
      "typoOverlay": {
        "headline": "Deep, Lasting Hydration",
        "subtext": "Visible balance within one day"
      }
    },
    {
      "shotIndex": 4,
      "abcdStage": "Proof",
      "durationSeconds": 6,
      "keyframeFile": "work/shot_4.png",
      "clipFile": "work/shot_4.mp4",
      "visualPrompt": "Macro studio shot of luminous golden hyaluronic serum droplets suspended in crystal-clear water with soft cyan (#38BDF8) and amber (#F59E0B) light refraction on deep navy (#0F172A). Clean commercial cinema frame with no overlaid UI text, buttons, subtitles, or watermarks.",
      "motionPrompt": "[VISUAL ANCHOR LOCK] Golden serum spheres suspended in clear liquid keep crisp spherical boundaries and the same color palette. [CAMERA TRAJECTORY] Gentle Crane-Up Reveal through floating micro-droplets. [LIGHTING & MICRO-PHYSICS] Slow fluid suspension drift with shimmering cyan and amber light refraction.",
      "voiceoverSegment": "Dermatologically tested, fragrance free, and gentle enough for every single morning.",
      "typoOverlay": {
        "headline": "+84% Hydration in 24h",
        "subtext": "Dermatologically tested moisture barrier support"
      }
    },
    {
      "shotIndex": 5,
      "abcdStage": "Direct",
      "durationSeconds": 6,
      "keyframeFile": "work/shot_5.png",
      "clipFile": "work/shot_5.mp4",
      "visualPrompt": "Hero composition echoing the opening lighting: amber serum bottle beside fresh Arctic cloudberries on dark slate (#0F172A) placed on the left third, generous clean negative space on the right two-thirds lit by golden dawn rim light and ice-blue (#38BDF8) accents. Clean commercial cinema frame with no overlaid UI text, buttons, subtitles, or watermarks.",
      "motionPrompt": "[VISUAL ANCHOR LOCK] Amber serum bottle and cloudberries on the left third of the dark slate table remain sharp and fixed. [CAMERA TRAJECTORY] Stable Locked Hero Frame with a subtle micro push-in. [LIGHTING & MICRO-PHYSICS] Soft golden morning rim light and gentle floating bokeh particles in the negative space.",
      "voiceoverSegment": "Reveal your natural radiance today, only with NordicGlow.",
      "typoOverlay": {
        "headline": "Your Glow, Every Morning",
        "subtext": "NordicGlow Radiant Renewal Serum"
      }
    }
  ]
}
```
