//! Cross-layer contract: domain AiProviderPreset is the sole preset authority
//! and every entry has exactly one matching runtime descriptor / base URL.

use junban_ai::{
    AiProviderPreset, OriginClass, ProviderEndpoint, ProviderKind, ProviderPreset, SecretString,
    builtin_providers, descriptor, descriptor_by_id,
};
use junban_domain::ProviderBaseUrl;

const SYNTH: &str = "synth-credential-fixture-authority-cc33dd44";

#[test]
fn every_domain_preset_has_exactly_one_runtime_descriptor() {
    // ProviderPreset is an alias of AiProviderPreset — same type, one authority.
    assert_eq!(
        std::any::TypeId::of::<ProviderPreset>(),
        std::any::TypeId::of::<AiProviderPreset>()
    );
    assert_eq!(AiProviderPreset::ALL.len(), 13);
    assert_eq!(builtin_providers().len(), AiProviderPreset::ALL.len());

    for preset in AiProviderPreset::ALL {
        let matches: Vec<_> = builtin_providers()
            .iter()
            .filter(|entry| entry.preset == preset)
            .collect();
        assert_eq!(
            matches.len(),
            1,
            "preset {} must have exactly one descriptor",
            preset.as_str()
        );

        let desc = descriptor(preset);
        assert_eq!(desc.preset, preset);
        assert_eq!(desc.id().as_str(), preset.as_str());
        assert_eq!(desc.id().as_str(), ProviderPreset::as_str(preset));

        match preset {
            AiProviderPreset::Custom => {
                assert!(preset.official_base_url().is_none());
                assert_eq!(desc.default_base_url, "");
                assert_eq!(desc.origin_class, OriginClass::OperatorCustom);
            }
            _ => {
                let official = preset
                    .official_base_url()
                    .expect("non-custom presets expose an official base URL");
                assert_eq!(
                    desc.default_base_url,
                    official,
                    "descriptor default URL must equal domain official_base_url for {}",
                    preset.as_str()
                );

                ProviderBaseUrl::for_provider(preset, official).unwrap_or_else(|error| {
                    panic!(
                        "domain must accept official origin for {}: {error}",
                        preset.as_str()
                    )
                });

                let credential = if desc.auth.requires_credential() {
                    Some(SecretString::new(SYNTH))
                } else {
                    None
                };
                let endpoint = ProviderEndpoint::resolve(desc, Some(official), credential)
                    .unwrap_or_else(|error| {
                        panic!(
                            "runtime must accept official origin for {}: {error}",
                            preset.as_str()
                        )
                    });
                assert_eq!(endpoint.base_url, official);

                // Divergent origin rejected by both layers for fixed cloud presets.
                if desc.origin_class == OriginClass::FixedCloudHttps {
                    assert!(
                        ProviderBaseUrl::for_provider(preset, "https://evil.example/v1").is_err(),
                        "domain must reject foreign origin for {}",
                        preset.as_str()
                    );
                    let credential = Some(SecretString::new(SYNTH));
                    assert!(
                        ProviderEndpoint::resolve(
                            desc,
                            Some("https://evil.example/v1"),
                            credential
                        )
                        .is_err(),
                        "runtime must reject foreign origin for {}",
                        preset.as_str()
                    );
                }
            }
        }
    }

    // No extra registry entries beyond domain ALL.
    for entry in builtin_providers() {
        assert!(
            AiProviderPreset::ALL.contains(&entry.preset),
            "registry entry {} is not in domain ALL",
            entry.preset.as_str()
        );
    }
}

#[test]
fn inventory_includes_deepseek_and_excludes_xai() {
    assert!(AiProviderPreset::ALL.contains(&AiProviderPreset::DeepSeek));
    assert!(descriptor_by_id("deepseek").is_ok());
    let deepseek = descriptor(AiProviderPreset::DeepSeek);
    assert_eq!(deepseek.default_base_url, "https://api.deepseek.com");
    assert_eq!(deepseek.chat_path, "chat/completions");
    assert_eq!(deepseek.models_path, Some("models"));
    assert_eq!(deepseek.kind, ProviderKind::OpenAiChatCompletions);

    assert!(AiProviderPreset::parse("xai").is_err());
    assert!(descriptor_by_id("xai").is_err());
    assert!(!builtin_providers().iter().any(|entry| {
        entry.preset.as_str() == "xai" || entry.default_base_url.contains("api.x.ai")
    }));
}

#[test]
fn canonical_ids_are_snake_case_with_safe_parse_aliases() {
    assert_eq!(AiProviderPreset::LmStudio.as_str(), "lm_studio");
    assert_eq!(AiProviderPreset::ZAi.as_str(), "z_ai");
    assert_eq!(
        descriptor(AiProviderPreset::LmStudio).id().as_str(),
        "lm_studio"
    );
    assert_eq!(descriptor(AiProviderPreset::ZAi).id().as_str(), "z_ai");

    assert_eq!(
        descriptor_by_id("lmstudio").unwrap().preset,
        AiProviderPreset::LmStudio
    );
    assert_eq!(
        descriptor_by_id("lm-studio").unwrap().preset,
        AiProviderPreset::LmStudio
    );
    assert_eq!(
        descriptor_by_id("zai").unwrap().preset,
        AiProviderPreset::ZAi
    );
    assert_eq!(
        descriptor_by_id("glm").unwrap().preset,
        AiProviderPreset::ZAi
    );
    assert_eq!(
        descriptor_by_id("moonshot").unwrap().preset,
        AiProviderPreset::Kimi
    );

    assert_eq!(
        AiProviderPreset::Gemini.official_base_url(),
        Some("https://generativelanguage.googleapis.com/v1beta")
    );
    assert_eq!(
        AiProviderPreset::DashScope.official_base_url(),
        Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1")
    );
    assert_eq!(
        AiProviderPreset::DeepSeek.official_base_url(),
        Some("https://api.deepseek.com")
    );
}
