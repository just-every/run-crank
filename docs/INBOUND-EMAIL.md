# Inbound workflow email

Choose an `email` trigger, publish the workflow and open **Account → Provider settings → Manage inbound email**. Only the current native workflow owner can create, rotate or revoke an address. Enter the installation's inbound domain and save the address shown once. Crank stores its hash. Creating an alias does not change DNS or configure Cloudflare.

The Worker exports an `email` handler for Cloudflare Email Routing. The buyer must separately configure their inbound domain and routing destination. Actual domain routing, delivery and provider bounces have not been established by the native transport fixtures.

The optional `sender_allowlist` contains exact envelope sender addresses or exact domains. A domain does not include its subdomains. The visible From header and forwarded-original fields are mappable data and supply no sender authority. Without an allowlist, any syntactically valid envelope sender is eligible.

Optional `authentication` requirements name `spf`, `dkim` or `dmarc`. The current Worker message API supplies no independently trusted authentication result. A configured requirement therefore refuses every delivery until such evidence is supported. Neither Authentication-Results nor Received-SPF in the message can satisfy it.

The raw stream is limited to 25 MiB including headers, framing and attachments. MIME parsing permits at most 80 parts and eight nesting levels, with at most 200 headers and 64 KiB of headers per part. Decoded text is limited to 1 MiB in total, an encoded leaf to 2 MiB, and the serialized parsed payload to 1 MiB before sealing. Each attachment uses the existing file custody limit of 1 MiB, with at most 20 files. Unsupported or malformed encodings, ambiguous Message-ID headers, missing Message-ID and unclosed multipart messages are refused before admission. Supported text charsets are UTF-8, ASCII, ISO-8859-1 and Windows-1252; transfer encodings are base64, quoted printable and ordinary byte text. HTML is retained as literal data.

Mappings can read `trigger.sender`, `trigger.recipients`, `trigger.cc`, `trigger.subject`, `trigger.text`, `trigger.html`, `trigger.headers`, `trigger.forwarded`, `trigger.envelope` and `trigger.files.attachment_0` onward. File references contain name, media type, byte count and SHA-256; bytes remain in installation custody. Forwarded messages may be attached original messages or conventional inline forwarding. Original fields never supply authentication evidence.

Message-ID is hashed and scoped to the workflow. `dedup_window_minutes` defaults to 1440 and accepts one minute to 30 days. Alias rotation preserves that workflow identity. Admission and file retention commit with one queued run or held item; duplicate, refusal and admission decisions appear in Runs, including when filtered to one workflow, and in Settings. Paused, burst and unfunded deliveries are held under the existing review process. Revocation also prevents subsequent dispatch from an admitted wait or held item.

Customer, financial and health payloads and attachments use the workflow's sealed custody. Ordinary retention, legal holds and run erasure apply. Erasure retains an opaque event fence so replay cannot recreate erased files. Export includes inactive aliases and value-free decisions, plus existing run and file custody records. Restore cannot reactivate receiving; create a new address after adoption. Provider routing and provider copies remain outside the archive.

This native receiving component does not establish the required live forwarded PDF to HubSpot journey, installation-domain delivery, bounces, live authentication evidence or downstream AI acceptance.
