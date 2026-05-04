const express = require("express");
const { generateAdImage } = require("../services/imageGenerator.js");

const router = express.Router();

router.get("/test-image", async (req, res) => {
  try {
    const prompt = `
    Create a premium advertisement image for a fashion brand.

    Style:
    - Modern
    - Clean
    - High contrast
    - Instagram ad style

    Layout:
    - Bold headline
    - Minimal text
    - CTA button

    Visual:
    - Lifestyle fashion imagery
    `;

    const image = await generateAdImage(prompt);

    res.json({
      success: true,
      image
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Image generation failed"
    });
  }
});

module.exports = router;
