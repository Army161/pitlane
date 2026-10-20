# Deterministic fixture provenance

The account fixtures are synthetic bytes generated in mints.ts, using the original SPL Mint layout (82 bytes), Token-2022 mint padding/account type/TLV framing, and official extension layouts pinned by @solana/spl-token 0.4.15. TokenMetadata follows the official Borsh interface. These contain no chain observations, wallet keys, customer data or live money. They exercise parsers and must never be represented as provider evidence. Hosted release proof requires independently acquired observations.
