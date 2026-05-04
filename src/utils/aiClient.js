const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateAdImage: generateVertexAdImage } = require('../services/imageGenerator');

// ─── Lazy Gemini (only when Google key present) ─────────────────────────────
let genAI;
let geminiModel;

function getGeminiModel() {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) return null;
  if (!genAI) genAI = new GoogleGenerativeAI(key);
  if (!geminiModel) {
    geminiModel = genAI.getGenerativeModel({
      model: process.env.GEMINI_MARKETING_MODEL || 'gemini-2.5-flash',
    });
  }
  return geminiModel;
}

function parseJsonObjectFromModelText(response, label) {
  const text = typeof response === 'string' ? response : String(response || '');
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');

  if (jsonStart === -1 || jsonEnd === -1) {
    console.error(`[AI Client] No JSON braces in ${label}. Preview:`, text?.substring(0, 500));
    throw new Error(`Failed to extract JSON from ${label}. Length: ${text?.length || 0}`);
  }

  const jsonString = text.slice(jsonStart, jsonEnd + 1);
  try {
    return JSON.parse(jsonString);
  } catch (parseErr) {
    console.error(`[AI Client] JSON.parse failed (${label}):`, parseErr.message);
    console.error('[AI Client] JSON preview:', jsonString.substring(0, 400));
    throw new Error(`JSON parse error (${label}): ${parseErr.message}`);
  }
}

function buildBusinessAnalysisUserPrompt(inputText) {
  return `
You are an expert AI marketing strategist.

Analyze the provided business data (website content, PDFs, description) and generate a complete marketing intelligence report.

Return STRICT JSON in this structure:

{
  "businessSummary": "A clear 2-3 line summary of what the business does and who it serves.",
  "tags": ["industry", "business model", "region"],
  "brandPersonality": {
    "archetype": "e.g. Creator / Innovator / Leader",
    "traits": ["trait1", "trait2", "trait3", "trait4"]
  },
  "keyDifferentiators": [
    "point 1",
    "point 2",
    "point 3",
    "point 4"
  ],
  "products": [
    {
      "name": "Product name",
      "category": "Category",
      "description": "Short one-line description",
      "image": "image url if available or null"
    }
  ],
  "competitors": [
    {
      "name": "Competitor name",
      "type": "direct or indirect",
      "description": "Short description",
      "strengths": ["point1", "point2"]
    }
  ],
  "brandMaturity": {
    "stage": "early_stage / growth / mature",
    "explanation": "2-3 line explanation"
  },
  "growthPriorities": [
    {
      "title": "Awareness",
      "description": "Short explanation"
    },
    {
      "title": "Acquisition",
      "description": "Short explanation"
    },
    {
      "title": "Retention",
      "description": "Short explanation"
    },
    {
      "title": "Reputation",
      "description": "Short explanation"
    },
    {
      "title": "Innovation",
      "description": "Short explanation"
    }
  ],
  "paidStrategy": {
    "budget": "low / medium / growth",
    "channels": ["Search", "Social", "Display"],
    "description": "Short explanation"
  },
  "organicStrategy": {
    "contentPillars": ["pillar1", "pillar2", "pillar3"],
    "platforms": ["Instagram", "TikTok", "Blog"],
    "description": "Short explanation"
  },
  "campaignRecommendations": [
    {
      "title": "Campaign name",
      "type": "Search / Social / Influencer",
      "priority": "high / medium / low",
      "description": "One-line actionable idea"
    }
  ],

  "researchDirection": {
    "goals": [
      "Actionable research goal 1",
      "Actionable research goal 2",
      "Actionable research goal 3"
    ],
    "platforms": ["Platform1", "Platform2", "Platform3"],
    "questions": [
      "Key audience research question 1",
      "Key audience research question 2",
      "Key audience research question 3"
    ]
  },

  "reputationManagement": {
    "urgency": "low / medium / high",
    "focusAreas": [
      "Focus area 1",
      "Focus area 2",
      "Focus area 3"
    ],
    "insight": "Short explanation of why reputation management matters for this business"
  },

  "businessSignals": {
    "location": "Country or region",
    "currency": "Currency code with symbol e.g. INR (₹)",
    "pricingLevel": "Budget / Mid-range / Premium / Luxury",
    "businessModel": "D2C / Marketplace / SaaS / B2B / Agency / Subscription",
    "industry": "Primary industry e.g. Fashion, EdTech, Healthcare",
    "targetMarket": "Global / Regional / Local"
  }
}

INPUT DATA:
${inputText}

RULES:
- NEVER return "N/A" or null for any field
- If data is missing, intelligently infer based on industry and context
- businessSignals must ALWAYS have all 6 fields populated — infer if not obvious
- Keep language concise, confident, and marketing-focused
- Do NOT explain anything outside JSON
- Always return at least:
  - 3 products
  - 3 competitors
  - 4 campaign recommendations

TONE:
- Strategic
- Confident
- Actionable
- No generic phrases
`.trim();
}

async function generateBusinessAnalysisGemini(inputText) {
  const model = getGeminiModel();
  if (!model) {
    throw new Error('Gemini is not configured (missing GOOGLE_GENERATIVE_AI_API_KEY)');
  }

  const prompt = buildBusinessAnalysisUserPrompt(inputText);

  console.log('[AI Client] Business analysis via Gemini...');
  const result = await model.generateContent(prompt);
  const response = result.response.text();
  console.log('[AI Client] Raw Gemini response length:', response?.length || 0);

  return parseJsonObjectFromModelText(response, 'Gemini business analysis');
}

async function generateBusinessAnalysis(inputText) {
  const gemini = getGeminiModel();
  if (!gemini) throw new Error('Gemini is not configured (missing GOOGLE_GENERATIVE_AI_API_KEY)');
  return await generateBusinessAnalysisGemini(inputText);
}

// ─── Ad Campaign Generation ─────────────────────────────────────────────────

function buildAdCampaignUserPrompt(businessContext) {
  const platformMap = {
    google: 'Google Ads',
    meta: 'Meta Ads',
    linkedin: 'LinkedIn Ads',
    tiktok: 'TikTok Ads',
    instagram: 'Instagram Ads',
  };
  const selectedPlatforms = (businessContext.selectedPlatforms || ['google', 'meta']).map(
    (p) => platformMap[p] || p
  );
  const platformList = selectedPlatforms.join(', ');
  const campaignsPerPlatform = 2;
  const campaignCount = selectedPlatforms.length * campaignsPerPlatform;

  return `
You are an expert performance marketing strategist and ad copywriter.

Given the following business context, generate production-ready ad campaigns.

BUSINESS CONTEXT:
${JSON.stringify(businessContext, null, 2)}

Generate ad campaigns ONLY for the following platforms:
${platformList}

DO NOT include any other platforms.

Return STRICT JSON in this exact structure:

{
  "campaigns": [
    {
      "platform": "Google Ads",
      "campaignName": "Short descriptive name",
      "goal": "Conversions / Traffic / Awareness",
      "headlines": [
        "Headline 1 (max 30 chars)",
        "Headline 2 (max 30 chars)",
        "Headline 3 (max 30 chars)",
        "Headline 4 (max 30 chars)",
        "Headline 5 (max 30 chars)"
      ],
      "descriptions": [
        "Description 1 (max 90 chars)",
        "Description 2 (max 90 chars)"
      ],
      "primaryText": "",
      "cta": "Learn More",
      "targeting": {
        "audience": "Short audience description",
        "interests": [],
        "keywords": ["keyword1", "keyword2", "keyword3", "keyword4"]
      }
    },
    {
      "platform": "Meta Ads",
      "campaignName": "Short descriptive name",
      "goal": "Conversions / Traffic / Awareness",
      "headlines": [
        "Headline 1",
        "Headline 2",
        "Headline 3"
      ],
      "descriptions": [
        "Description 1",
        "Description 2"
      ],
      "primaryText": "Longer engaging post text for social feed (2-3 sentences)",
      "cta": "Shop Now",
      "targeting": {
        "audience": "Short audience description",
        "interests": ["Interest1", "Interest2", "Interest3"],
        "keywords": []
      }
    }
  ]
}

RULES:
- Generate ad campaigns ONLY for the following platforms: ${platformList}
- DO NOT include any other platforms.
${
  Array.isArray(businessContext.campaignTypes) && businessContext.campaignTypes.length > 0
    ? `- The user selected these strategic campaign ideas from their business brief — align names, angles, and copy with them (you may refine titles): ${JSON.stringify(
        businessContext.campaignTypes.map((c) => ({
          title: c.title || c.name,
          type: c.type,
          priority: c.priority,
          description: c.description,
        }))
      )}`
    : ''
}
- Generate EXACTLY ${campaignCount} campaigns total — ${campaignsPerPlatform} per selected platform
- For EACH selected platform, generate EXACTLY 2 campaigns with DIFFERENT goals/angles
- Every campaign MUST be for one of the selected platforms
- Google Ads headlines MUST be under 30 characters each
- Google Ads descriptions MUST be under 90 characters each
- Make headlines punchy, specific, and action-oriented
- Avoid generic phrases like "Best Quality" or "Great Service"
- Include REAL targeting data based on the business context
- Google campaigns MUST have keywords, Social campaigns MUST have interests
- primaryText is only for social platforms (Meta, Instagram, TikTok, LinkedIn)
- CTA options: "Shop Now", "Learn More", "Sign Up", "Contact Us", "Get Quote", "Book Now", "Download", "Apply Now"
- Each campaign should have a DIFFERENT goal or angle
- Make it feel like a real media buyer wrote these

NEVER return null values. If data is unclear, infer intelligently from context.
Return JSON only — no markdown, no text outside the JSON object.
`.trim();
}

function filterCampaignsToSelectedPlatforms(parsed, selectedPlatforms) {
  if (!parsed.campaigns || !Array.isArray(parsed.campaigns)) {
    throw new Error('Invalid response structure: missing campaigns array');
  }
  parsed.campaigns = parsed.campaigns.filter((c) => {
    const p = (c.platform || '').toLowerCase();
    return selectedPlatforms.some(
      (sp) => p.includes(sp.toLowerCase()) || sp.toLowerCase().includes(p)
    );
  });
  if (parsed.campaigns.length === 0) {
    throw new Error('AI failed to generate any campaigns for the requested platform(s). Failsafe triggered.');
  }
  return parsed;
}

async function generateAdCampaignsGemini(businessContext) {
  const model = getGeminiModel();
  if (!model) {
    throw new Error('Gemini is not configured (missing GOOGLE_GENERATIVE_AI_API_KEY)');
  }

  const platformMap = {
    google: 'Google Ads',
    meta: 'Meta Ads',
    linkedin: 'LinkedIn Ads',
    tiktok: 'TikTok Ads',
    instagram: 'Instagram Ads',
  };
  const selectedPlatforms = (businessContext.selectedPlatforms || ['google', 'meta']).map(
    (p) => platformMap[p] || p
  );

  const prompt = buildAdCampaignUserPrompt(businessContext);

  console.log('[AI Client] Generating ad campaigns via Gemini...');

  let result;
  let retries = 0;
  while (retries < 2) {
    try {
      result = await model.generateContent(prompt);
      break;
    } catch (err) {
      if (err.message && err.message.includes('429')) {
        console.warn('[AI Client] Rate limit hit. Waiting 8 seconds before retry...');
        await new Promise((r) => setTimeout(r, 8000));
        retries++;
      } else {
        throw err;
      }
    }
  }

  if (!result) throw new Error('Failed to generate content after retries');

  const response = result.response.text();
  const parsed = parseJsonObjectFromModelText(response, 'Gemini ad campaigns');
  filterCampaignsToSelectedPlatforms(parsed, selectedPlatforms);
  console.log(
    '[AI Client] Filtered and retained',
    parsed.campaigns.length,
    'valid ad campaigns (text only — images handled by controller)'
  );
  return { campaigns: parsed.campaigns };
}

async function generateAdCampaigns(businessContext) {
  if (!getGeminiModel()) throw new Error('Gemini is not configured (missing GOOGLE_GENERATIVE_AI_API_KEY)');
  return await generateAdCampaignsGemini(businessContext);
}

// ─── Ad Image Generation (Vertex Imagen) ──

function buildCompactAdImagePrompt({
  businessOverview,
  campaignName,
  primaryText,
  platform,
}) {
  const isGoogle = platform?.toLowerCase().includes('google');
  const aspectHint = isGoogle ? 'wide horizontal 16:9 composition' : 'square 1:1 composition';
  return `Professional advertising photograph for ${platform || 'social'}: ${aspectHint}.
Brand: ${businessOverview || 'A modern business'}.
Campaign: ${campaignName || 'Brand campaign'}.
Key message: ${primaryText || 'Shop now'}.
Style: premium, clean, high-end commercial photography, soft natural light, sharp focus, no text overlays, no watermarks, no logos drawn in-frame.`;
}

async function generateAdImage({
  businessOverview,
  campaignName,
  primaryText,
  platform,
}) {
  const isGoogle = platform?.toLowerCase().includes('google');
  const aspectRatio = isGoogle ? '16:9' : '1:1';
  const prompt = buildCompactAdImagePrompt({
    businessOverview,
    campaignName,
    primaryText,
    platform,
  });
  const imageUrl = await generateVertexAdImage(prompt, aspectRatio);
  return { imageUrl, model: 'imagen-3.0-generate-001' };
}

module.exports = {
  generateBusinessAnalysis,
  generateAdCampaigns,
  generateAdImage,
};
