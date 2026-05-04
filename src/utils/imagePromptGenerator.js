const nichePhotos = {
  'real estate': `Premium real-estate site photography that matches the actual property environment, cinematic golden-hour natural lighting, realistic land textures and terrain details, ultra-realistic commercial photography, edge-to-edge composition filling entire frame`,
  'fashion': `High-end editorial fashion photograph, single model in premium designer outfit, clean studio with soft directional lighting, neutral cream backdrop, shallow depth of field, Vogue magazine cover quality, full-frame edge-to-edge`,
  'food': `Premium gourmet dish photographed from above on dark marble surface, artful plating with vibrant fresh ingredients, soft warm side lighting creating elegant shadows, appetizing restaurant menu quality, full-frame edge-to-edge composition`,
  'technology': `Sleek premium technology product on minimal matte black surface, soft gradient blue-purple ambient lighting, clean reflections, Apple-style product photography, futuristic and minimal, full-frame edge-to-edge`,
  'health': `Serene wellness scene with person meditating in nature at sunrise, soft golden light filtering through trees, calm and peaceful atmosphere, premium health brand aesthetic, full-frame edge-to-edge`,
  'education': `Bright modern library or co-working space with warm natural light streaming through large windows, clean desks with books and laptops, aspirational learning atmosphere, full-frame edge-to-edge`,
  'finance': `Dramatic modern glass skyscraper reflecting golden sunset, shot from ground level looking up, corporate power and trust, deep blue sky with warm golden tones, full-frame architectural photography, edge-to-edge`,
  'ecommerce': `Premium product flatlay on clean white marble surface with soft studio lighting, elegant minimal composition, luxury unboxing aesthetic, warm tones, catalog quality, full-frame edge-to-edge`,
  'travel': `Breathtaking luxury resort with infinity pool overlooking turquoise ocean at sunset, palm trees silhouetted against vibrant sky, paradise destination photography, full-frame edge-to-edge`,
  'beauty': `Luxury skincare products arranged on rose gold marble surface with soft pink peony flowers, warm feminine lighting, elegant beauty brand aesthetic, premium packaging close-up, full-frame edge-to-edge`,
  'default': `Premium professional commercial photography, high-end presentation, clean modern aesthetic, well-lit studio environment, extremely detailed and visually striking, edge-to-edge composition`,
};

const IMAGEN_BOOST = `8k resolution, ultra realistic, shot on RED Monstro, 35mm lens, f/1.8, shallow depth of field, cinematic lighting, global illumination, hyper-detailed textures, unreal engine 5 render style, professional commercial photography, no text, no watermark`;

/**
 * Normalizes the niche by matching substrings or returning default.
 */
function getBasePrompt(niche) {
  if (!niche) return nichePhotos['default'];
  const lowerNiche = niche.toLowerCase();
  for (const [key, prompt] of Object.entries(nichePhotos)) {
    if (lowerNiche.includes(key)) return prompt;
  }
  return nichePhotos['default'];
}

function detectSiteEnvironment(analysis = {}) {
  const text = [
    analysis.siteContext,
    analysis.businessOverview,
    analysis.primaryText,
    analysis.headline,
    analysis.productOrService,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!text) return null;

  const farmlandSignals = [
    'farmland', 'farm land', 'agricultural', 'agriculture', 'acre', 'plot', 'plots',
    'open land', 'green land', 'valley', 'hills', 'rural', 'nature', 'mountain',
    'karjat', 'investment land',
  ];
  const urbanSignals = [
    'high-rise', 'high rise', 'tower', 'skyline', 'skyscraper', 'downtown', 'metro',
    'apartment', 'condo', 'commercial building',
  ];

  const farmlandHit = farmlandSignals.some((k) => text.includes(k));
  const urbanHit = urbanSignals.some((k) => text.includes(k));

  if (farmlandHit && !urbanHit) return 'farmland';
  if (urbanHit && !farmlandHit) return 'urban';
  return null;
}

function buildEnvironmentDirectives(niche, analysis = {}) {
  const lowerNiche = String(niche || '').toLowerCase();
  if (!lowerNiche.includes('real estate')) return [];

  const env = detectSiteEnvironment(analysis);
  if (env === 'farmland') {
    return [
      'depict real farmland/open plot environment with greenery, natural terrain, and surrounding hills when relevant',
      'rural landscape real-estate presentation, land-investment visual storytelling',
      'avoid city skyline, high-rise towers, glass skyscrapers, dense urban downtown scenes',
    ];
  }
  if (env === 'urban') {
    return [
      'depict realistic urban real-estate environment aligned with city project context',
    ];
  }
  return [
    'match the actual site environment from campaign context; do not invent a conflicting location style',
  ];
}

/**
 * Cleans up and joins the prompt parts, filtering out empty ones.
 */
function buildFinalPrompt(parts) {
  return parts
    .filter(part => part && part.trim() !== '')
    .map(part => part.trim())
    .join(', ');
}

/**
 * Generates a high-quality Imagen 3 prompt.
 *
 * @param {string} niche - The business niche/industry
 * @param {Object} analysis - The dynamic analysis data (tone, audience, etc.)
 */
function generateImagePrompt(niche, analysis = {}) {
  const base = getBasePrompt(niche);
  
  const additionalDetails = [];
  const env = detectSiteEnvironment(analysis);
  const envDirectives = buildEnvironmentDirectives(niche, analysis);
  
  if (analysis.audience) additionalDetails.push(`target audience: ${analysis.audience}`);
  if (analysis.tone) additionalDetails.push(`tone: ${analysis.tone}`);
  if (analysis.emotion) additionalDetails.push(`mood: ${analysis.emotion}`);
  if (analysis.style) additionalDetails.push(`style: ${analysis.style}`);
  if (analysis.colors) {
    const colorStr = Array.isArray(analysis.colors) ? analysis.colors.join(' and ') : analysis.colors;
    additionalDetails.push(`color palette: ${colorStr}`);
  }
  if (analysis.lighting) additionalDetails.push(`lighting: ${analysis.lighting}`);
  if (analysis.platform) additionalDetails.push(`optimized for ${analysis.platform} ads`);
  if (analysis.productOrService) additionalDetails.push(analysis.productOrService);
  if (analysis.headline) additionalDetails.push(`ad headline context: "${analysis.headline}"`);
  if (analysis.primaryText) additionalDetails.push(`ad primary text context: "${analysis.primaryText}"`);
  if (analysis.cta) additionalDetails.push(`call to action: "${analysis.cta}"`);
  if (analysis.logo) additionalDetails.push(`include logo: ${analysis.logo}`);
  if (analysis.businessOverview) additionalDetails.push(`business context: ${analysis.businessOverview}`);
  if (analysis.siteContext) additionalDetails.push(`site context: ${analysis.siteContext}`);
  additionalDetails.push(...envDirectives);
  if (env === 'farmland') {
    additionalDetails.push('ONLY farmland/rural land investment visual context');
    additionalDetails.push('strict negative: no skyscrapers, no city towers, no dense urban skyline, no glass business district');
    additionalDetails.push('natural gradients, greenery, open plots, valley or hill backdrop where relevant');
  }

  additionalDetails.push('high-converting advertisement creative');
  additionalDetails.push('scroll-stopping premium composition');
  
  const parts = [
    base,
    ...additionalDetails,
    IMAGEN_BOOST
  ];

  return buildFinalPrompt(parts);
}

/**
 * Generates variants of high-quality Imagen 3 prompts.
 *
 * @param {string} niche - The business niche/industry
 * @param {Object} analysis - The dynamic analysis data
 * @returns {Array<string>} An array of 5 prompt variants
 */
function generateImageVariants(niche, analysis = {}) {
  const base = getBasePrompt(niche);
  const env = detectSiteEnvironment(analysis);
  const envDirectives = buildEnvironmentDirectives(niche, analysis);
  
  const variants = env === 'farmland'
    ? [
      { name: 'aerial land layout', detail: 'drone aerial farmland view, visible open plots, natural contour lines, premium land investment framing' },
      { name: 'approach road and plots', detail: 'approach road entering green plot area, realistic rural infrastructure, cinematic natural lighting' },
      { name: 'hillside farmland panorama', detail: 'wide panoramic shot with hills, mist and green farmlands, no urban structures' },
      { name: 'sunset investment mood', detail: 'golden-hour farmland investment scene with open land parcels and natural depth' },
      { name: 'ground-level site view', detail: 'human eye-level site perspective, realistic terrain texture, plantation-rich environment' },
    ]
    : [
      { name: 'hero shot', detail: 'dramatic hero angle, monumental scale, center focused' },
      { name: 'close-up detail', detail: 'extreme macro close-up detail, showing texture and precise craftsmanship' },
      { name: 'lifestyle usage', detail: 'candid lifestyle setting, aspirational environment, dynamic everyday usage situation' },
      { name: 'cinematic wide angle', detail: 'cinematic ultra-wide establishing shot, breathtaking vast environment context' },
      { name: 'product focus', detail: 'studio perfect product isolation, dramatic rim lighting, intense focus on subject' }
    ];

  return variants.map(variant => {
    const localAnalysis = { ...analysis };
    
    const additionalDetails = [];
    if (localAnalysis.audience) additionalDetails.push(`target audience: ${localAnalysis.audience}`);
    if (localAnalysis.tone) additionalDetails.push(`tone: ${localAnalysis.tone}`);
    if (localAnalysis.emotion) additionalDetails.push(`mood: ${localAnalysis.emotion}`);
    if (localAnalysis.colors) {
        const colorStr = Array.isArray(localAnalysis.colors) ? localAnalysis.colors.join(' and ') : localAnalysis.colors;
        additionalDetails.push(`color palette: ${colorStr}`);
    }
    if (localAnalysis.productOrService) additionalDetails.push(localAnalysis.productOrService);
    if (localAnalysis.headline) additionalDetails.push(`ad headline context: "${localAnalysis.headline}"`);
    if (localAnalysis.primaryText) additionalDetails.push(`ad primary text context: "${localAnalysis.primaryText}"`);
    if (localAnalysis.cta) additionalDetails.push(`call to action: "${localAnalysis.cta}"`);
    if (localAnalysis.logo) additionalDetails.push(`include logo: ${localAnalysis.logo}`);
    if (localAnalysis.businessOverview) additionalDetails.push(`business context: ${localAnalysis.businessOverview}`);
    if (localAnalysis.siteContext) additionalDetails.push(`site context: ${localAnalysis.siteContext}`);
    additionalDetails.push(...envDirectives);
    if (env === 'farmland') {
      additionalDetails.push('ONLY farmland/rural land investment visual context');
      additionalDetails.push('strict negative: no skyscrapers, no city towers, no dense urban skyline, no downtown roads');
    }

    additionalDetails.push(variant.detail);
    additionalDetails.push('high-converting advertisement creative');

    const parts = [
      base,
      ...additionalDetails,
      IMAGEN_BOOST
    ];
    return buildFinalPrompt(parts);
  });
}

module.exports = {
  generateImagePrompt,
  generateImageVariants,
  detectSiteEnvironment,
};
