-- Ollama through its own API, beside the OpenAI-compatible "self-hosted" kind (docs/18-llm.md).
alter table llm_profiles drop constraint llm_profiles_provider_check;
alter table llm_profiles add constraint llm_profiles_provider_check
  check (provider in ('openai', 'anthropic', 'azure-openai', 'azure-foundry', 'openrouter', 'ollama', 'self-hosted'));
