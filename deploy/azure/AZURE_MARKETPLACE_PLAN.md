# LibreDB Studio — Microsoft Azure Marketplace Ücretsiz Listeleme Planı

**Hazırlanma tarihi:** 2026-08-05
**Hedef:** LibreDB Studio'yu Microsoft Marketplace'te (Azure Marketplace) **ücretsiz** (para akışı olmayan,
"Get It Now (Free)") bir teklif olarak yayına almak.
**Ürün sahibi tüzel kişilik:** Sekoya Grup Bilisim ve Teknoloji Ltd. Sti. (İstanbul, Türkiye)
**Ürün/marka adı:** LibreDB Studio · yayıncı markası: LibreDB

> **Bu doküman kime yazıldı?** Süreci yürütecek yazılımcıya (ve yanında çalışacak yapay zekâ asistanına).
>
> **Önce [§0 — Görev dağılımı](#0-görev-dağılımı--kim-neyi-yapar)'nı okuyun:** hangi işin insan
> tarafından yapılması *zorunlu* olduğu, hangisinin AI'ya delege edilebileceği ve AI'ya verilecek
> hazır istem şablonları oradadır. Dokümanın tamamında 🧑 (yalnızca insan), 🤖 (AI yapabilir) ve
> 🧑🤖 (birlikte) işaretleri kullanılır.
>
> Kod blokları doğrudan uygulanabilir referans implementasyondur; ancak **hiçbir kod bloğu
> doğrulanmadan Partner Center'a gönderilmemelidir** — §12'deki "Doğrulanması zorunlu varsayımlar"
> listesine bakın.

---

## İçindekiler

0. [**Görev dağılımı — kim neyi yapar**](#0-görev-dağılımı--kim-neyi-yapar)
1. [Yönetici özeti ve alınan karar](#1-yönetici-özeti-ve-alınan-karar)
2. [Teklif tipi karşılaştırması — neden Solution Template?](#2-teklif-tipi-karşılaştırması--neden-solution-template)
3. [Doğrulanmış gerçekler ve kaynaklar](#3-doğrulanmış-gerçekler-ve-kaynaklar)
4. [Faz 0 — Hesap, doğrulama, ön koşullar](#4-faz-0--hesap-doğrulama-ön-koşullar)
5. [Faz 1 — Teknik paket (mimari + tam referans kod)](#5-faz-1--teknik-paket-mimari--tam-referans-kod)
6. [Faz 2 — Yerel doğrulama ve gerçek Azure testi](#6-faz-2--yerel-doğrulama-ve-gerçek-azure-testi)
7. [Faz 3 — Partner Center'da teklifin oluşturulması (alan alan)](#7-faz-3--partner-centerda-teklifin-oluşturulması-alan-alan)
8. [Faz 4 — Preview, sertifikasyon ve Go live](#8-faz-4--preview-sertifikasyon-ve-go-live)
9. [Faz 5 — Yayın sonrası: repoya entegrasyon](#9-faz-5--yayın-sonrası-repoya-entegrasyon)
10. [Sürüm güncelleme runbook'u](#10-sürüm-güncelleme-runbooku)
11. [Riskler, ret sebepleri ve azaltımlar](#11-riskler-ret-sebepleri-ve-azaltımlar)
12. [Doğrulanması zorunlu varsayımlar](#12-doğrulanması-zorunlu-varsayımlar)
13. [Opsiyonel Faz 6 — Azure Container (Kubernetes app) teklifi](#13-opsiyonel-faz-6--azure-container-kubernetes-app-teklifi)
14. [Opsiyonel Faz 7 — Azure Virtual Machine teklifi](#14-opsiyonel-faz-7--azure-virtual-machine-teklifi)
15. [Ekler](#15-ekler)

---

## 0. Görev dağılımı — kim neyi yapar

Bu bölüm dokümanın en önemli kısmıdır. Dokümanın geri kalanındaki her tabloda bir **"Kim"** kolonu
vardır; buradaki işaretler oralarda da kullanılır.

| İşaret | Anlamı |
|---|---|
| 🧑 | **Yalnızca insan.** AI yapamaz veya yapmamalıdır (portal oturumu, hukuki taahhüt, kimlik doğrulama, para, geri alınamaz onay). |
| 🤖 | **AI yapabilir.** Kod, script, metin, doğrulama, dosya üretimi. İnsan sonucu gözden geçirir; kimse gözden geçirmeden merge etmez. |
| 🧑🤖 | **Birlikte.** AI hazırlar/analiz eder, insan portalda uygular veya son kararı verir. |

### 0.1 AI'nın **kesinlikle yapmaması gereken** işler

Bunlar tartışmaya kapalıdır. AI'ya bu işleri yaptırmayın, oturum çerezi/parola paylaşmayın:

| # | İş | Neden |
|---|---|---|
| M1 | Partner Center / Azure portal oturumu açmak, MFA kodu girmek | Hesap güvenliği; Microsoft Publisher Agreement'ın imza sahibi gerçek kişidir |
| M2 | **Microsoft Publisher Agreement**'ı ve Standard Contract'ı kabul etmek | Şirket adına hukuki taahhüt; imza yetkisi gerektirir |
| M3 | Kimlik doğrulama (devlet kimliği yüklemek), işletme/domain belgesi göndermek | Kişisel veri + resmî belge; insan sorumluluğu |
| M4 | **"Go live" butonuna basmak** | Geri alınamaz; teklif tüm dünyaya açılır |
| M5 | Offer ID / offer type / plan type seçimi kesinleştirmek | **Sonradan değiştirilemez** (yeni teklif açmak gerekir) |
| M6 | Azure aboneliği açmak, ödeme yöntemi girmek | Finansal |
| M7 | Microsoft ile e-posta yazışması, ret itirazı (appeal) göndermek | Kurumsal iletişim, taahhüt içerir |
| M8 | Gerçek kimlik bilgisi (JWT secret, üretim parolası, PAT, abonelik anahtarı) üretip bir dosyaya yazmak | Sır yönetimi; sırlar repoya veya dokümanlara asla girmez |
| M9 | Logo/ekran görüntüsü için **marka kararı** vermek | Marka sahipliği |
| M10 | Hukuki metin seçimi (Standard Contract mı kendi şartlarımız mı) | Hukuki sonuç doğurur |

### 0.2 AI'nın rahatlıkla yapabileceği işler

| # | İş | Çıktı |
|---|---|---|
| A1 | `mainTemplate.json` yazmak, sertifikasyon kurallarına (§6.3) göre denetlemek | dosya + kontrol raporu |
| A2 | `createUiDefinition.json` yazmak, çıktı adlarını template parametreleriyle karşılaştırmak | dosya + fark listesi |
| A3 | `install.sh` yazmak, `shellcheck`'ten geçirmek | dosya + lint çıktısı |
| A4 | `scripts/build-azure-package.mjs` yazmak (digest çözümü, placeholder doldurma, zip) | dosya |
| A5 | GitHub Actions workflow'u yazmak ve action'ları SHA ile pinlemek | dosya |
| A6 | `arm-ttk` çalıştırmak, kırmızı testleri tek tek düzeltmek | düzeltilmiş dosyalar |
| A7 | `az deployment group create` ile test deployment koşturmak, §6.2 kabul kriterlerini uygulamak (**AI'ya Azure CLI erişimi verildiyse**) | test raporu |
| A8 | Listeleme metinlerini yazmak, karakter limitlerini ölçmek | `listing-fields.md`, `description.html` |
| A9 | Ekran görüntülerini 1280×720'e kadrajlamak, logoyu 300×300 düz-zemin PNG'ye çevirmek (script) | görsel dosyalar |
| A10 | "Notes for certification" metnini güncel tutmak | metin |
| A11 | `distribution/channels.yaml` + `docs/CHANNELS.md` + `README.md` güncellemeleri, `bun run distribution:matrix` | commit |
| A12 | Sertifikasyon ret raporunu okuyup ihlal edilen politika maddesini kod değişikliğine çevirmek | PR |
| A13 | `deploy/azure/README.md` ve sürüm güncelleme runbook'unu yazmak | doküman |
| A14 | Microsoft dokümantasyonunu tarayıp bu plandaki varsayımların hâlâ geçerli olduğunu doğrulamak (§12) | doğrulama notu |

### 0.3 Faz faz özet

| Faz | 🧑 İnsan payı | 🤖 AI payı | Kritik el değiştirme noktası |
|---|---|---|---|
| **Faz 0** — hesap & doğrulama | ~%95 | ~%5 (belge kontrol listesi hazırlama) | Yok — bu faz insan işidir |
| **Faz 1** — teknik paket | ~%10 (kararlar, gözden geçirme) | ~%90 | Kod review + merge insanın |
| **Faz 2** — test | ~%30 (portal sandbox, abonelik) | ~%70 | Sandbox'ı insan açar, AI çıktıyı yorumlar |
| **Faz 3** — Partner Center formu | ~%80 (portalda yazma/yükleme) | ~%20 (metinleri hazırlama) | AI metni üretir → insan kopyalar |
| **Faz 4** — preview & go live | ~%90 | ~%10 (preview'da test koşturma) | **Go live sadece insan** |
| **Faz 5** — repo entegrasyonu | ~%10 | ~%90 | PR'ı insan onaylar |
| **Sürüm güncelleme** | ~%40 (yükleme + Go live) | ~%60 (paket üretimi + test) | Her seferinde aynı |

### 0.4 AI'ya iş verirken kullanılacak istem (prompt) şablonları

Yazılımcı bu blokları doğrudan kendi AI asistanına verebilir. Her biri **tek bir çıktı** üretir.

**Faz 1 — teknik paket:**
```
Bu repoda deploy/azure/AZURE_MARKETPLACE_PLAN.md dosyası var. §5'teki referans koda göre
şu dosyaları oluştur: deploy/azure/src/mainTemplate.json, deploy/azure/src/createUiDefinition.json,
deploy/azure/src/install.sh, scripts/build-azure-package.mjs,
.github/workflows/azure-marketplace-package.yml.

Kurallar:
- TDD: `tests/unit/build-azure-package.test.ts` testini ÖNCE yaz (repo'da her scripts/*.mjs testli).
- §6.3'teki sertifikasyon kontrol listesindeki her maddeyi sağla ve sağladığını madde madde raporla.
- apiVersion değerlerini `az provider show` ile doğrula, dokümandaki değerleri körlemesine kullanma.
- mainTemplate.json ve createUiDefinition.json gerçek JSON'dur: yorum satırı olmayacak.
- Template'e Microsoft.Resources/deployments tipinde HİÇBİR kaynak ekleme (§3-F6/F7).
- Hiçbir gerçek parola/secret üretip dosyaya yazma.
- install.sh'i shellcheck'ten geçir.
- Bitirince repo'nun altı zorunlu kontrolünü çalıştır: `bun run format && bun run lint &&
  bun run typecheck && bun run knip && bun run test && bun run build`.
- Bitirince: değiştirdiğin her dosyayı ve §12'de doğrulanamayan kalan varsayımları listele.
```

**Faz 2 — doğrulama:**
```
dist/azure/package klasörünü arm-ttk ile doğrula (Test-AzMarketplacePackage). Kırmızı çıkan her
testi düzelt, sarıları gerekçesiyle raporla. Sonra createUiDefinition.json'ın outputs bölümündeki
her anahtarın mainTemplate.json parameters bölümünde aynı isim ve uyumlu tiple bulunduğunu
tablo halinde karşılaştır. Eksik/fazla varsa düzelt.
```

**Faz 3 — listeleme içeriği:**
```
deploy/azure/listing/ altında listing-fields.md ve description.html üret. Kaynak:
AZURE_MARKETPLACE_PLAN.md §7.3. Her alan için karakter sayısını ölç ve limitle birlikte yaz
(name 200, search summary 100, short description 256, description 5000). Limit aşan hiçbir alan
kalmasın. Uydurma özellik yazma — yalnızca README.md ve docs/ içinde gerçekten belgelenmiş
yetenekleri anlat.
```

**Faz 5 — repo entegrasyonu:**
```
Azure Marketplace kanalını distribution/channels.yaml'a ekle (§9'daki hazır giriş),
`bun run distribution:matrix` çalıştır, docs/CHANNELS.md'nin son satırındaki "Planned ... GCP,
Azure, AWS" listesinden Azure'u çıkar, README'nin install bölümüne linki ekle. Sonra
`bun run distribution:check` ve repo'nun zorunlu altı kontrolünü (format, lint, typecheck, knip,
test, build) çalıştır.
```

---

## 1. Yönetici özeti ve alınan karar

**Karar: "Azure Application" teklif tipi → "Solution template" planı → "Get It Now (Free)" listeleme.**

Müşteri Marketplace'ten "Get It Now" der, Azure portalında bir sihirbaz açılır, kendi Azure aboneliğine
bir Ubuntu 24.04 LTS sanal makinesi kurulur, VM ilk açılışta LibreDB Studio konteynerini (GHCR'dan) ve
önüne otomatik TLS yapan bir Caddy konteynerini çalıştırır. **Bize hiçbir para akışı olmaz; müşteri
sadece kendi Azure altyapı bedelini öder.** Bizim tarafta banka/vergi profili gerekmez.

**Neden bu yol:**

| Kriter | Sonuç |
|---|---|
| Ücretsiz mi? | Evet — Solution template planları Marketplace üzerinden **transact edilemez**, sadece "Get It Now (Free)" ile listelenir |
| Banka/vergi profili gerekli mi? | **Hayır** — Microsoft: *"If you only plan to list free offers, you don't need to fill out any tax forms or set up a payout profile."* |
| VHD (disk imajı) üretmek gerekiyor mu? | Hayır — Canonical'ın Marketplace'teki hazır Ubuntu imajı kullanılır |
| Azure Container Registry, CNAB paketleme gerekiyor mu? | Hayır (bunlar Container/Kubernetes teklifi için gerekir) |
| Mevcut varlıklarımızı kullanır mı? | Evet — `ghcr.io/libredb/libredb-studio` imajı ve DigitalOcean 1-Click'te kanıtlanmış systemd+Docker deseni |
| Teslim edilecek teknik çıktı | 2 dosyalık bir `.zip`: `mainTemplate.json` + `createUiDefinition.json` |

**Tahmini efor:** teknik paket 2–4 gün (test dahil), Partner Center içerik girişi 1 gün, hesap doğrulama
3–5 iş günü (paralel yürür), sertifikasyon birkaç iş günü ile birkaç hafta arası (SLA yok).

> **Ticari beklenti notu:** Ücretsiz olmanın bir bedeli var — *"Get It Now (Free) offers aren't
> eligible for Marketplace Rewards benefits for transactable offers. Because there's no transaction
> through the storefront, these are categorized as **Trial**."* Yani Microsoft'un pazarlama/co-sell
> teşvik paketinden tam olarak yararlanamayız. Bu kararı değiştirmez (ürün zaten ücretsiz ve MIT),
> ama "Marketplace'e girince Microsoft bizi pazarlar" beklentisiyle girilmemeli.

**En büyük iki risk:** (a) Partner Center hesap doğrulamasının (business/employment verification)
uzaması, (b) sertifikasyonda ARM template kural ihlali. Her ikisinin de azaltımı §11'de.

---

## 2. Teklif tipi karşılaştırması — neden Solution Template?

Microsoft Marketplace'te bir teklif tipi seçtikten sonra **değiştiremezsiniz**; farklı tip istiyorsanız
yeni teklif açmanız gerekir. Bu yüzden karar bilinçli verilmelidir.

| Teklif tipi | Ücretsiz olabilir mi? | Bizim için gereken iş | Karar |
|---|---|---|---|
| **Azure Application → Solution template** | ✅ Get It Now (Free) | ARM template + createUiDefinition (2 dosya, zip) | ✅ **SEÇİLDİ (Faz 1–5)** |
| Azure Application → Managed application | Hayır (transactable; abonelik/metered zorunlu mantığı) | Aynı + yönetilen kaynak grubu, publisher tenant erişimi | ❌ Bize uymuyor |
| **Azure Container (Kubernetes app)** | ✅ "Free" lisans modeli var | ACR + CNAB paketleme + Helm chart'ın imaj referanslarının parametrelenmesi + zafiyet taraması; sadece AKS/Arc | 🟡 **Opsiyonel Faz 6** (chart'ımız zaten var, ikinci kanal olarak değerli) |
| **Azure Virtual Machine** | Kısmen (BYOL / free fiyat seçeneği var ama transactable altyapı) | VHD üretimi, imaj sertifikasyon testleri, Shared Image Gallery | 🟡 **Opsiyonel Faz 7** (yalnızca Solution Template reddedilirse plan B) |
| SaaS | ✅ Get It Now (Free) mümkün | Bizim ürünü **biz barındırırdık** + Entra ID SSO zorunlulukları | ❌ Ürün modeline uymuyor (self-hosted ürünüz) |

> **Not — konteyner/AKS kısıtı.** Bu kural **sertifikasyon politikalarında değil**,
> [`plan-azure-application-offer`](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/plan-azure-application-offer)
> sayfasının *"Usage of Azure Kubernetes Service (AKS) and containers in managed application"*
> başlığı altındadır (ret raporunda "300.x" diye bir madde aramayın). Birebir:
>
> > *"**Solution templates:** The Solution Template offers aren't changeable by the publisher after
> > customer deployment. Therefore, containers and Azure Kubernetes Service (AKS) resources aren't
> > currently supported for Solution templates."*
>
> Gerekçenin **teknik değil sözleşmesel** olduğuna dikkat: sorun "konteyner" değil, yayınlandıktan
> sonra publisher'ın çözümü değiştirememesi. Bizim tasarımımız ARM tarafında hiçbir
> `Microsoft.ContainerService/*` veya `Microsoft.ContainerInstance/*` kaynağı oluşturmuyor; Docker,
> VM'in içinde uygulamanın nasıl başlatıldığına dair bir uygulama detayı. Bu yorum piyasadaki VM
> tabanlı solution template'lerin standart uygulamasıdır — ama **savunulması gereken bir yorumdur**,
> o yüzden §11-R2b'de ayrı bir risk olarak izleniyor ve "Notes for certification" metninde açıkça
> beyan ediliyor.

---

## 3. Doğrulanmış gerçekler ve kaynaklar

Aşağıdakiler bu dokümanın yazımı sırasında (2026-08-05) Microsoft Learn'den **doğrudan okunarak**
doğrulanmıştır. Alıntılar İngilizce orijinaldir.

| # | Gerçek | Kaynak |
|---|---|---|
| F1 | *"Solution template plans aren't transactable in Microsoft Marketplace"* — yani ücretsiz listeleme | [plan-azure-application-offer](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/plan-azure-application-offer) |
| F2 | Solution template **Get It Now (Free)** listeleme seçeneğini destekleyen tek Azure Application plan tipidir | [determine-your-listing-type](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/determine-your-listing-type) |
| F3 | *"If you only plan to list free offers, you don't need to fill out any tax forms or set up a payout profile."* | [set-up-your-payout-account](https://learn.microsoft.com/en-us/partner-center/account-settings/set-up-your-payout-account) |
| F4 | Deployment package = kök dizininde `mainTemplate.json` + `createUiDefinition.json` bulunan bir `.zip` | [plan-azure-app-solution-template](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/plan-azure-app-solution-template) |
| F5 | *"The deployment package must not include binaries such as Virtual Machine images. All images deployed by the Azure Application must be images referenced from Microsoft Marketplace."* | aynı kaynak |
| F6 | **Customer usage attribution zorunludur**, ancak Marketplace Azure app'lerinde tracking ID'yi **Partner Center otomatik ekler**: *"As you update your offers, you no longer need to add the Microsoft.Resources/deployments resource type in your main template file."* | [azure-partner-customer-usage-attribution](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/azure-partner-customer-usage-attribution) |
| F7 | ⚠️ Template'te **başka bir amaçla** `Microsoft.Resources/deployments` kaynağı varsa Microsoft tracking ID'yi otomatik ekleyemez; o zaman elle eklemek gerekir | aynı kaynak |
| F8 | Paket, yüklemeden önce **ARM template test toolkit** ile doğrulanmalı: `Test-AzMarketplacePackage -TemplatePath "<klasör>"`, kırmızı sonuç = sertifikasyon reddi | [test-toolkit](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/test-toolkit) |
| F9 | Hesap: iş (work) hesabı zorunlu, kişisel hesap kabul edilmez; Microsoft Publisher Agreement imzalanır; yetkili imza sahibi olmak gerekir | [create-account](https://learn.microsoft.com/en-us/partner-center/account-settings/create-account) |
| F10 | Doğrulama tipleri: e-posta, kimlik, istihdam (domain belgesi), işletme (ticaret sicil belgesi); *"In most cases, the process takes three to five business days"* | [understand-the-verification-process](https://learn.microsoft.com/en-us/partner-center/enroll/understand-the-verification-process) |
| F11 | Logo: **216×216 – 350×350 px PNG** (zorunlu, "Large"); Partner Center Small/Medium'u türetir. Ekran görüntüleri: **tam 1280×720 px PNG**, en fazla 5 adet, her birine caption zorunlu | [plan-azure-application-offer](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/plan-azure-application-offer) |
| F12 | Ad ≤200 karakter, "Search results summary" ≤100 karakter, "Short description" ≤256 karakter, "Description" ≤5000 karakter (HTML dahil), en fazla 3 arama anahtar kelimesi | aynı kaynak |
| F13 | Sertifikasyon politikası 300.4.4: `location` parametresi `[resourceGroup().location]` varsayılanlı olmalı ve `allowedValues` içermemeli; securestring parametrelerin varsayılanı olamaz | [certification-policies](https://learn.microsoft.com/en-us/legal/marketplace/certification-policies) |
| F14 | 300.4.5: hard-coded URI/endpoint yasak; `apiVersion` en fazla 24 ay eski olabilir ve literal olmalı; VM eklentilerinde `autoUpgradeMinorVersion: true`; secureString kullanan eklentiler `protectedSettings` kullanmalı | aynı kaynak |
| F15 | 300.4.8: VM imajı **platform veya Marketplace imajı** olmalı (custom image yasak); OS/Data diskleri **implicit managed disk** olmalı; VM boyutu `createUiDefinition`'da SizeSelector ile seçilmeli | aynı kaynak |
| F16 | 100.1.1: yeniden paketlenmiş açık kaynak yazılım başlıkta katma değeri belirtmeli **veya satıcı adını içermeli** (biz ürünün asıl geliştiricisiyiz — "LibreDB Studio" adı uygundur) | aynı kaynak |
| F17 | Ubuntu 24.04 LTS Gen2 URN'i: `Canonical:ubuntu-24_04-lts:server:latest` (Gen1: `server-gen1`), LTS non-Pro imajları ücretsizdir | [Ubuntu on Azure docs](https://ubuntu.com/azure/docs/azure-how-to/instances/find-ubuntu-images/) |
| F18 | Yayın akışı: Automated validation → Certification → Preview creation → Publisher sign-off (**Go live** butonu) → Publish. Otomatik adımlar dakikalar sürer; **manuel sertifikasyon için yayınlanmış bir SLA yoktur** | [review-publish-offer](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/review-publish-offer) |
| F19 | Kategori kuralı: en fazla 2 kategori (1 primary + 1 secondary), her biri için en fazla 2 alt kategori. İlgili kategoriler: **Developer Tools → Tools**, **Databases → Relational Databases / NoSQL Databases**, **IT & Management Tools → Management Solutions**, **DevOps** | [marketplace-categories-industries](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/marketplace-categories-industries) |
| F20 | **Marketplace Ingestion MCP server** mevcut (`https://ingestion-mcp.marketplace-ingestion.mp.microsoft.com/mcp`) — ancak **lansmanda yalnızca SaaS ve M365/Copilot tekliflerini destekliyor**, Azure Application'ı desteklemiyor | [ingestion-mcp](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/ingestion-mcp) |

> **Not:** "Azure Marketplace" ve "AppSource" markaları **Microsoft Marketplace** çatısı altında
> birleştirildi (mağaza: <https://marketplace.microsoft.com>). Dokümantasyon `learn.microsoft.com/partner-center/marketplace-offers/...`
> altına taşındı; eski `learn.microsoft.com/azure/marketplace/...` linkleri yönlendirme yapıyor.

---

## 4. Faz 0 — Hesap, doğrulama, ön koşullar

Bu faz **tamamen insan işidir** ve en uzun süren kısımdır; Faz 1'i beklemeden **hemen başlatın**
(paralel yürütülür).

| # | Adım | Kim | Süre | Notlar |
|---|---|---|---|---|
| 0.1 | Şirketin Microsoft Entra ID (iş hesabı) tenant'ı olduğunu doğrula (ör. `sekoya.tech` domainli hesap) | 🧑 | — | Kişisel Microsoft hesabı **kabul edilmez** (F9) |
| 0.2 | <https://partner.microsoft.com> → Partner Center kaydı. Zaten Microsoft AI Cloud Partner Program (eski MPN) hesabı varsa **yeni hesap açma**, mevcut hesaptan "Microsoft Marketplace" programına enroll et | 🧑 | 1 saat | [create-account](https://learn.microsoft.com/en-us/partner-center/account-settings/create-account) |
| 0.3 | Microsoft Publisher Agreement'ı kabul et (imza yetkisi olan kişi yapmalı) | 🧑 | — | |
| 0.4 | Hesap doğrulaması: e-posta, kimlik (devlet kimliği), istihdam (**domain sahiplik belgesi**: registrar'dan alınan, şirket adı+adres+tarihleri içeren belge), işletme (**ticaret sicil / faaliyet belgesi**) | 🧑 | **3–5 iş günü** (uzayabilir) | Şirket adı ve adresi **resmî kayıtla birebir aynı** olmalı, kısaltma/yazım hatası olmamalı |
| 0.5 | Publisher profili oluştur: publisher ID, şirket adı ("Sekoya Grup Bilisim ve Teknoloji Ltd. Sti."), **Partner ID (MPN ID)** bağla | 🧑 | — | |
| 0.6 | Bildirimleri alacak kullanıcıları ekle (Owner + Manager/Developer rolleri); Action Center'da e-posta doğrula | 🧑 | — | Sertifikasyon hata raporları buraya düşer |
| 0.7 | **Vergi/banka profili KURMA** — ücretsiz teklif için gerekmiyor (F3) | — | — | Sonradan transactable'a geçilirse eklenir |
| 0.8 | Test için bir Azure aboneliği hazırla (deployment testleri ve preview audience için subscription ID gerekecek) | 🧑 | — | Pay-as-you-go yeterli; test VM'leri saatlik ~$0.05 |
| 0.9 | **libredb.org'da eksik hukuki sayfalar**: `/privacy-policy` var ✅, **Terms of Use sayfası yok** ❌ | 🧑🤖 | 0.5 gün | Çözüm A (önerilen): Partner Center'da **Standard Contract** kullan, kendi şartlarını yazma. Çözüm B: `libredb.org/terms` sayfası yayınla |
| 0.10 | Destek kanalı netleştir: destek URL'i (`https://github.com/libredb/libredb-studio/issues`) + destek e-postası + mühendislik iletişim kişisi (telefon zorunlu alan) | 🧑 | — | Mühendislik iletişimi listede görünmez, sadece Microsoft kullanır |

**Faz 0 çıkış kriteri:** Partner Center → Account settings → Legal info sayfasında genel doğrulama
durumu **"Authorized"**, ve Settings → Account settings → Programs listesinde **Microsoft Marketplace**
kayıtlı görünüyor.

---

## 5. Faz 1 — Teknik paket (mimari + tam referans kod)

> **🤖 Bu fazın tamamı AI'ya delege edilebilir** (§0.4'teki "Faz 1" istemi). İnsanın rolü: PR'ı
> gözden geçirmek ve merge etmek. Tek istisna 🧑 **§5.2'deki dosya/dizin yerleşimi kararı** —
> repo konvansiyonuna aykırı bir yere yazılmasın.

### 5.1 Mimari

```
Müşteri: Marketplace → "Get It Now" → Azure portal sihirbazı (createUiDefinition.json)
                                              │
                                              ▼
                            ARM deployment (mainTemplate.json)
                                              │
      ┌───────────────────────────────────────┼───────────────────────────────────┐
      ▼                    ▼                  ▼                ▼                  ▼
  VNet + Subnet         NSG            Public IP (Standard,  NIC          VM (Ubuntu 24.04 LTS,
  10.10.0.0/16   80←Internet (ACME)    Static, DNS label)              Canonical Marketplace imajı)
                 443←müşteri kısıtı
                 (+22 opsiyonel)
                                                                                  │
                                                              CustomScript extension (protectedSettings)
                                                                                  │
                                                                 /opt/libredb-install.sh (inline, base64)
                                                                                  │
                                        ┌─────────────────────────────────────────┴──────────────┐
                                        ▼                                                        ▼
                          docker: libredb-studio                                    docker: caddy
                          ghcr.io/libredb/libredb-studio@sha256:...                  :80 → :443 otomatik TLS
                          127.0.0.1:3000 (sadece loopback)                           reverse_proxy → libredb-studio:3000
                          volume: /opt/libredb/data → /app/data                      Let's Encrypt (<dns>.<region>.cloudapp.azure.com)
```

**Tasarım gerekçeleri (sertifikasyon kurallarıyla eşleşme):**

| Tasarım kararı | Gerekçe / karşıladığı kural |
|---|---|
| Kurulum script'i template'e **base64 gömülü**, dışarıdan indirilmiyor | Asıl fayda: **çalışma zamanında script indirilmiyor** — daha az kırılganlık, deterministik kurulum, `_artifactsLocation` altyapısına ihtiyaç yok. ⚠️ Bunu "hard-coded URI yasağını (F14) karşılıyor" diye okumayın: base64 yalnızca arm-ttk'nin string tabanlı `Must Not Contain Hardcoded Uri` testinden gizler; script içindeki GHCR / Docker Hub / ACME / IMDS adresleri hâlâ oradadır ve sertifikasyon **gerçek trafiği** izler ("network calls monitoring"). Bu yüzden çıkış bağlantıları "Notes for certification"da tek tek beyan edilir |
| Script argümanları **base64 kodlu** geçiliyor | Shell quoting/injection riski sıfır; parola içinde özel karakter olsa bile bozulmaz |
| Parola ve e-posta **`protectedSettings`** içinde | F14: "Extensions using secureStrings: use protectedSettings" |
| VM imajı `Canonical:ubuntu-24_04-lts:server:latest` | F5 + F15: Marketplace imajı zorunlu, custom image yasak. LTS non-Pro imajı ücretsiz (F17) |
| Disk: `managedDisk` + `StandardSSD_LRS`, storage account yok | F15: implicit managed disk zorunlu |
| VM boyutu parametre + `Microsoft.Compute.SizeSelector` | F15 |
| Template'te **hiç `Microsoft.Resources/deployments` kaynağı yok** | F6/F7: Partner Center customer usage attribution ID'sini otomatik enjekte edebilsin |
| Uygulama portu (3000) **sadece 127.0.0.1'e** publish ediliyor | En az yetki; NSG'de 3000 açık değil |
| SSH kuralı **varsayılan olarak yok**; sadece müşteri bir kaynak CIDR verirse açılır | 300.4.2 "NSG'ler makul olmalı" |
| Varsayılan HTTPS (Caddy + Let's Encrypt, Azure DNS label FQDN'i üzerinden) | 100.11 "kullanıcı güvenliğini tehlikeye atmamalı" — login formu düz HTTP'de olmasın |
| **HTTPS açıkken NSG kuralları ikiye ayrılır:** 80 her zaman `Internet`'e açık, 443 müşterinin verdiği kaynak aralığına kısıtlı | Caddy adlandırılmış bir site için **otomatik HTTPS** yapar: `:443`'te sunar, `:80`'i oraya 308 ile yönlendirir. Sertifika alınamazsa uygulama **her iki portta** erişilemez olur. Let's Encrypt HTTP-01 challenge'ı **yalnızca 80'e** ihtiyaç duyar; bu yüzden 80'i açık tutup 443'ü kısıtlamak hem sertifikayı garanti eder hem de "arayüzü kendi IP aralığıma kısıtla" yeteneğini korur. (İlk tasarımda tek bir kural her iki portu birden kısıtlıyordu ve müşteri CIDR girdiğinde sertifika **sessizce** hiç alınamıyordu.) 80 portunda ACME challenge'ı ve HTTPS yönlendirmesi servis edilir |
| **TLS düşüşü müşterinin kısıtına saygı duyar:** kaynak `Internet` ise `:80`'e düşer, kısıtlıysa `:443`'te **self-signed** sertifikayla kalır | Port 80 ACME için `Internet`'e açık olduğundan, kısıtlı bir kurulumda uygulamayı `:80`'e taşımak müşterinin koyduğu sınırı **sessizce baypas eder** ve login formunu şifresiz olarak herkese açardı — 100.11'in ("kullanıcı güvenliğini tehlikeye atmamalı") doğrudan ihlali. Self-signed sertifika tarayıcıda uyarı verir ama **kısıt korunur ve trafik şifreli kalır**; buradaki alternatif "korkutucu HTTPS" değil, "internete açık düz HTTP"dir |
| ACME issuer'ında `disable_tlsalpn_challenge` | 443 müşterinin CIDR'ına kısıtlıyken TLS-ALPN-01 challenge'ı (Let's Encrypt'in **443'e** bağlanmasını gerektirir) başarısız olur; boşa geçen backoff süresi 180 saniyelik doğrulama penceresini yiyebilir ve **yenilemede** de aynı kumar atılır. Tek direktifle HTTP-01'e sabitlemek, tasarımın kendi iddiasını *umut* olmaktan çıkarıp *zorunlu* yapar |
| **Tek CA (Let's Encrypt) — bilinçli bedel** | Caddy varsayılan olarak bir issuer **çifti** dener (LE + yedek). `issuer` direktifini açıkça yazmak varsayılan listeyi **değiştirir**, yani yedek CA düşer. Bunu kabul ediyoruz çünkü: (a) `disable_tlsalpn_challenge` için açık issuer bloğu şart, (b) alternatif yedek CA'lar (ör. ZeroSSL) bugün **EAB kimlik bilgisi** istiyor — sıfır-yapılandırma vaadi olan bir Marketplace teklifinde müşteriden API anahtarı istenemez, (c) P1 sonrası düşüş yolu **güvenli**: sertifika alınamazsa kurulum kısıtı genişletmeden bozulmadan devam ediyor. Bedeli R4'ün olasılığına yansıtıldı (Düşük → Düşük–Orta). Gerçek issuer listesini §6.1 kontrol 2.9 ile ölçün |
| Kurulumun sonunda **gerçek TLS doğrulaması** (`curl --resolve <fqdn>:443:127.0.0.1`) ve başarısızsa **kısıt durumuna göre dallanan otomatik düşüş** (yukarıdaki "TLS düşüşü müşterinin kısıtına saygı duyar" satırı) | Yerel `127.0.0.1:3000` kontrolü uygulama ayakta diye "başarılı" derdi; deployment `Succeeded` görünürken duyurulan URL ölü olurdu. Azure bir VM'in kendi public IP'sine hairpin yapmayı garanti etmediği için doğrulama `--resolve` ile yerel Caddy'ye pinlenir — sertifika zinciri yine de gerçek olarak doğrulanır |
| `AUTH_BOOTSTRAP=off` + template'ten gelen açık `JWT_SECRET`/`ADMIN_PASSWORD` | Ürünün strict modu; üretim için önerilen mod (bkz. `docs/DISTRIBUTION.md`) |
| İmaj **digest ile pinlenir** (`@sha256:...`) | Tekrarlanabilir kurulum; paket sürümü ile çalışan sürüm birebir eşleşir |

### 5.2 Repo dosya yapısı (oluşturulacak)

```
deploy/azure/
├── AZURE_MARKETPLACE_PLAN.md      # bu doküman
├── README.md                       # kısa build + submit rehberi (Faz 1 sonunda yazılacak)
├── package-version.txt             # Partner Center'daki paket sürümü (tek doğruluk kaynağı)
├── listing/
│   ├── description.html            # Partner Center "Description" alanı (≤5000 karakter)
│   ├── listing-fields.md           # tüm form alanlarının birebir metinleri (§7.3)
│   └── assets/                     # logo-300.png, screenshot-*.png (1280×720)
└── src/
    ├── mainTemplate.json           # şablon (build script placeholder'ları doldurur)
    ├── createUiDefinition.json
    └── install.sh                  # VM ilk açılış kurulum script'i

scripts/build-azure-package.mjs     # paketi üretir: dist/azure/libredb-studio-azure-<ver>.zip
.github/workflows/azure-marketplace-package.yml
```

> **Repo kuralı:** Bu iş `deploy/azure/` altında yaşar. `deploy/gcp/` (Google Cloud) ve
> `deploy/rancher/` (SUSE) ayrı çalışmalardır, karıştırılmamalıdır.

### 5.3 `deploy/azure/src/install.sh`

```bash
#!/usr/bin/env bash
# LibreDB Studio — Azure Marketplace solution template first-boot installer.
#
# Executed by the CustomScript VM extension via protectedSettings.commandToExecute.
# Every argument is base64-encoded by the ARM template, so no shell quoting or
# injection is possible regardless of what the customer typed in the portal.
#
#   $1  admin email        (base64)
#   $2  admin password     (base64)
#   $3  site address       (base64)  FQDN for HTTPS, or ":80" for plain HTTP
#   $4  ACME contact       (base64)  may be empty
#   $5  web source prefix  (base64)  "Internet" or a CIDR — decides how the TLS
#                                    fallback may degrade without widening access
set -euo pipefail

exec > >(tee -a /var/log/libredb-install.log) 2>&1
echo "=== LibreDB Studio install started: $(date -Is) ==="

b64d() { printf '%s' "${1:-}" | base64 -d 2>/dev/null || true; }

APP_ADMIN_EMAIL="$(b64d "${1:-}")"
APP_ADMIN_PASSWORD="$(b64d "${2:-}")"
SITE_ADDRESS="$(b64d "${3:-}")"
ACME_EMAIL="$(b64d "${4:-}")"
WEB_SOURCE="$(b64d "${5:-}")"
[ -n "$WEB_SOURCE" ] || WEB_SOURCE="Internet"

# Injected by scripts/build-azure-package.mjs at package build time.
APP_IMAGE="__APP_IMAGE__"
CADDY_IMAGE="__CADDY_IMAGE__"

if [ -z "$APP_ADMIN_EMAIL" ] || [ -z "$APP_ADMIN_PASSWORD" ]; then
  echo "FATAL: admin credentials were not passed to the installer" >&2
  exit 1
fi
[ -n "$SITE_ADDRESS" ] || SITE_ADDRESS=":80"

# ---------------------------------------------------------------- packages ---
# DPkg::Lock::Timeout is not optional here: Azure's Canonical cloud images run
# apt-daily / unattended-upgrades on first boot, and the CustomScript extension
# races them. Without the timeout a lock collision fails apt, `set -e` kills the
# script, the extension reports Failed and the whole ARM deployment fails.
export DEBIAN_FRONTEND=noninteractive
# Belt: wait for cloud-init to finish its own package work before we start ours.
command -v cloud-init >/dev/null 2>&1 && cloud-init status --wait >/dev/null 2>&1 || true
# Braces: even after cloud-init, apt-daily/unattended-upgrades can hold the lock.
APT_OPTS=(-o DPkg::Lock::Timeout=600)
apt-get "${APT_OPTS[@]}" update -y
apt-get "${APT_OPTS[@]}" install -y --no-install-recommends \
  docker.io ca-certificates curl openssl
systemctl enable --now docker

# Registry hiccups must not fail the deployment on the first try.
pull_with_retry() {
  local ref="$1" i
  for i in 1 2 3 4 5; do
    if docker pull "$ref"; then return 0; fi
    echo "docker pull $ref failed (attempt $i), retrying in $((i * 10))s"
    sleep $((i * 10))
  done
  echo "FATAL: could not pull $ref" >&2
  return 1
}
pull_with_retry "$APP_IMAGE"
pull_with_retry "$CADDY_IMAGE"

# ------------------------------------------------------------------- layout ---
install -d -m 0755 /opt/libredb /opt/libredb/data /opt/libredb/caddy \
                   /opt/libredb/caddy/data /opt/libredb/caddy/config

# ---------------------------------------------------------------- app env ---
# Strict mode: no generated credentials, everything explicit (docs/DISTRIBUTION.md).
#
# Written once and never rewritten: if the extension re-runs (VM reimage, extension
# update), regenerating JWT_SECRET would invalidate every existing session.
if [ ! -f /etc/libredb-studio.env ]; then
  (
    umask 077   # scoped to this subshell so later files keep normal modes
    cat > /etc/libredb-studio.env <<EOF
AUTH_BOOTSTRAP=off
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
NEXT_PUBLIC_AUTH_PROVIDER=local
ADMIN_EMAIL=${APP_ADMIN_EMAIL}
ADMIN_PASSWORD=${APP_ADMIN_PASSWORD}
STORAGE_PROVIDER=sqlite
STORAGE_SQLITE_PATH=/app/data/libredb-storage.db
PORT=3000
HOSTNAME=0.0.0.0
EOF
  )
  chmod 600 /etc/libredb-studio.env
else
  echo "/etc/libredb-studio.env already exists — keeping the existing JWT secret"
fi

# ---------------------------------------------------------------- Caddyfile ---
{
  echo '{'
  echo '	admin off'
  if [ -n "$ACME_EMAIL" ]; then printf '\temail %s\n' "$ACME_EMAIL"; fi
  echo '}'
  echo ''
  printf '%s {\n' "$SITE_ADDRESS"
  if [ "$SITE_ADDRESS" != ":80" ]; then
    # Port 443 may be restricted to the customer's address range, so the TLS-ALPN-01
    # challenge (which Let's Encrypt performs against :443) can fail or waste backoff
    # time. Port 80 is open by design, so pin issuance and renewal to HTTP-01 instead
    # of leaving the choice to chance. The email is repeated here because an explicit
    # issuer block does not necessarily inherit the global one.
    echo '	tls {'
    echo '		issuer acme {'
    if [ -n "$ACME_EMAIL" ]; then printf '\t\t\temail %s\n' "$ACME_EMAIL"; fi
    echo '			disable_tlsalpn_challenge'
    echo '		}'
    echo '	}'
  fi
  echo '	encode zstd gzip'
  echo '	reverse_proxy libredb-studio:3000'
  echo '}'
} > /opt/libredb/caddy/Caddyfile
chmod 644 /opt/libredb/caddy/Caddyfile

# ------------------------------------------------------------------ network ---
docker network inspect libredb >/dev/null 2>&1 || docker network create libredb

# ------------------------------------------------------------ systemd units ---
cat > /etc/systemd/system/libredb-studio.service <<EOF
[Unit]
Description=LibreDB Studio
After=docker.service network-online.target
Wants=network-online.target docker.service

[Service]
ExecStartPre=-/usr/bin/docker rm -f libredb-studio
ExecStart=/usr/bin/docker run \\
  --name libredb-studio \\
  --init \\
  --network libredb \\
  -p 127.0.0.1:3000:3000 \\
  --env-file /etc/libredb-studio.env \\
  -v /opt/libredb/data:/app/data \\
  ${APP_IMAGE}
ExecStop=/usr/bin/docker stop libredb-studio
ExecStopPost=-/usr/bin/docker rm -f libredb-studio
Restart=always
RestartSec=10
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/libredb-caddy.service <<EOF
[Unit]
Description=LibreDB Studio reverse proxy (Caddy)
After=docker.service network-online.target libredb-studio.service
Wants=network-online.target docker.service

[Service]
ExecStartPre=-/usr/bin/docker rm -f libredb-caddy
ExecStart=/usr/bin/docker run \\
  --name libredb-caddy \\
  --init \\
  --network libredb \\
  -p 80:80 -p 443:443 \\
  -v /opt/libredb/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \\
  -v /opt/libredb/caddy/data:/data \\
  -v /opt/libredb/caddy/config:/config \\
  ${CADDY_IMAGE}
ExecStop=/usr/bin/docker stop libredb-caddy
ExecStopPost=-/usr/bin/docker rm -f libredb-caddy
Restart=always
RestartSec=10
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now libredb-studio libredb-caddy

# ------------------------------------------------------------- health gate ---
# 1) The application itself must answer. Response body is {"status":"healthy",...}.
ok=0
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/api/db/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
if [ "$ok" -ne 1 ]; then
  echo "FATAL: LibreDB Studio did not become healthy within 5 minutes" >&2
  docker logs libredb-studio --tail 200 || true
  exit 1
fi

# 2) If HTTPS was requested, the certificate must actually exist — otherwise the URL
#    we are about to advertise is dead on both ports (Caddy serves a named site on
#    :443 and 308-redirects :80 to it, so a failed certificate breaks BOTH).
#    --resolve pins the connection to the local Caddy while still validating the
#    real certificate chain and SNI; Azure does not reliably hairpin a VM's own
#    public IP, so a plain https://<fqdn> probe from the VM is not a valid test.
TLS_OK=1
FALLBACK_MODE=none
if [ "$SITE_ADDRESS" != ":80" ]; then
  TLS_OK=0
  for _ in $(seq 1 36); do
    if curl -fsS --resolve "${SITE_ADDRESS}:443:127.0.0.1" \
         "https://${SITE_ADDRESS}/api/db/health" >/dev/null 2>&1; then
      TLS_OK=1
      break
    fi
    sleep 5
  done
  if [ "$TLS_OK" -ne 1 ]; then
    # Degrade rather than leave an unreachable deployment behind — but NEVER degrade in a
    # way that reaches more people than the customer allowed. Port 80 is open to the
    # internet by design (ACME), so moving the app onto :80 is only safe when the customer
    # left port 443 open to the internet too.
    #
    # Remaining causes at this point (port 80 is guaranteed reachable by the template):
    # Let's Encrypt rate limit, a Let's Encrypt outage, or a firewall the customer added.
    docker logs libredb-caddy --tail 100 || true
    # Keep the HTTPS config verbatim so restoring it later also restores the ACME
    # contact address — rewriting only the site line would silently drop `email`.
    cp /opt/libredb/caddy/Caddyfile /opt/libredb/caddy/Caddyfile.https

    # "0.0.0.0/0" is spelled differently but means exactly what "Internet" means; treat
    # both as unrestricted. Anything else (a CIDR, VirtualNetwork, AzureLoadBalancer) is
    # narrower than the internet, so it takes the conservative branch.
    if [ "$WEB_SOURCE" = "Internet" ] || [ "$WEB_SOURCE" = "0.0.0.0/0" ]; then
      FALLBACK_MODE=http
      echo "WARNING: no valid TLS certificate after 3 minutes — falling back to plain HTTP on :80"
      printf '{\n\tadmin off\n}\n\n:80 {\n\tencode zstd gzip\n\treverse_proxy libredb-studio:3000\n}\n' \
        > /opt/libredb/caddy/Caddyfile
    else
      # The customer restricted port 443. Falling back to :80 would publish the
      # application to the entire internet. Stay on 443 with a self-signed certificate:
      # the restriction holds and the traffic stays encrypted. The browser will warn.
      FALLBACK_MODE=selfsigned
      echo "WARNING: no valid TLS certificate after 3 minutes — staying on :443 with a self-signed certificate (source range is restricted to ${WEB_SOURCE})"
      printf '{\n\tadmin off\n}\n\n%s {\n\ttls internal\n\tencode zstd gzip\n\treverse_proxy libredb-studio:3000\n}\n' \
        "$SITE_ADDRESS" > /opt/libredb/caddy/Caddyfile
    fi

    # Freeze the working fallback config here, not in the operator's restore hint. If the
    # operator makes the backup by hand and re-runs the restore block after a failed
    # attempt, the second run would overwrite the escape hatch with the broken HTTPS
    # config and there would be no way back short of re-running this installer.
    cp /opt/libredb/caddy/Caddyfile /opt/libredb/caddy/Caddyfile.fallback

    systemctl restart libredb-caddy
    for _ in $(seq 1 24); do
      if [ "$FALLBACK_MODE" = "http" ]; then
        curl -fsS "http://127.0.0.1/api/db/health" >/dev/null 2>&1 && break
      else
        # -k on purpose: the certificate is deliberately self-signed here.
        curl -fsSk --resolve "${SITE_ADDRESS}:443:127.0.0.1" \
          "https://${SITE_ADDRESS}/api/db/health" >/dev/null 2>&1 && break
      fi
      sleep 5
    done
  fi
fi

# ------------------------------------------------------------------- notice ---
# Azure Instance Metadata Service — link-local, no traffic leaves the virtual network.
PUBLIC_IP="$(curl -fsS -H 'Metadata:true' --noproxy '*' \
  'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text' 2>/dev/null || true)"

case "$FALLBACK_MODE" in
  http)       APP_URL="http://${PUBLIC_IP:-<public-ip>}" ;;
  selfsigned) APP_URL="https://${SITE_ADDRESS}" ;;
  *)          if [ "$SITE_ADDRESS" = ":80" ]; then APP_URL="http://${PUBLIC_IP:-<public-ip>}"
              else APP_URL="https://${SITE_ADDRESS}"; fi ;;
esac

RESTORE_HINT="     First find out WHY the certificate failed - the answer decides what to do:
       docker logs libredb-caddy 2>&1 | grep -i -m5 'acme\|challenge\|rate limit'
     * A connection error or timeout while fetching the challenge means port 80 was not
       reachable from the internet. That is measurable: from ANY machine other than this
       one, run
         curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 http://${SITE_ADDRESS}/
       Any HTTP status (404 included) means port 80 is reachable now. A timeout means it
       is still blocked - do not restore yet.
     * A rate limit cannot be probed at all. Let's Encrypt limits reset on a rolling
       weekly window, so the only remedy is to wait for the window to pass.
     Then restore. The working fallback config is already saved as Caddyfile.fallback, so
     a premature restore is recoverable:
       cp /opt/libredb/caddy/Caddyfile.https /opt/libredb/caddy/Caddyfile
       systemctl restart libredb-caddy
     If HTTPS still fails, go back with:
       cp /opt/libredb/caddy/Caddyfile.fallback /opt/libredb/caddy/Caddyfile
       systemctl restart libredb-caddy"

TLS_NOTE=""
if [ "$FALLBACK_MODE" = "http" ]; then
  TLS_NOTE="
  !! HTTPS was requested but no certificate could be issued, so the application is
     being served over plain HTTP on port 80. Port 443 was open to the internet in
     this deployment, so nothing is reachable that was not reachable before.
     Likely causes: a Let's Encrypt rate limit or outage, or a firewall added after
     deployment.
${RESTORE_HINT}
"
elif [ "$FALLBACK_MODE" = "selfsigned" ]; then
  TLS_NOTE="
  !! HTTPS was requested but no certificate could be issued. Because you restricted
     access to ${WEB_SOURCE}, the application was NOT moved to port 80 - that port is
     open to the internet for the certificate challenge, and moving there would have
     published the application to everyone. It is still served on port 443, inside your
     allowed range, with a SELF-SIGNED certificate, so your browser will warn you.
     Likely causes: a Let's Encrypt rate limit or outage, or a firewall added after
     deployment.
${RESTORE_HINT}
"
fi

cat > /etc/libredb-studio.info <<EOF
LibreDB Studio is running.

  URL:   ${APP_URL}
  Admin: ${APP_ADMIN_EMAIL}   (password: the one you entered during deployment)
${TLS_NOTE}

  Service:  systemctl status libredb-studio
  Logs:     docker logs libredb-studio
  Data:     /opt/libredb/data   (SQLite storage; survives restarts)
  Config:   /etc/libredb-studio.env   (mode 0600)
  Install log: /var/log/libredb-install.log

  Docs:    https://github.com/libredb/libredb-studio#readme
  Support: https://github.com/libredb/libredb-studio/issues
EOF
cp /etc/libredb-studio.info /etc/motd

echo "=== LibreDB Studio install finished: $(date -Is) ==="
```

**Bilinçli kararlar:**
- `docker.io` paketi Ubuntu deposundan kurulur — üçüncü parti apt reposu veya `get.docker.com`
  script'i indirilmez (daha az dış bağımlılık, teknik doğrulamada daha temiz ağ profili).
- Konteynerin kendi `docker-entrypoint.sh`'i mount edilen `/app/data` dizininin sahipliğini
  düzeltip root'tan `nextjs` kullanıcısına düşüyor — bu yüzden host tarafında chown gerekmiyor.
- Caddy imajı **`docker.io` üzerinden** çekiliyor. Docker Hub anonim çekme limitleri riski için
  §11-R6'ya bakın.

### 5.4 `deploy/azure/src/mainTemplate.json`

> 🔴 **`apiVersion` kuralı — "sonra bakarız" denecek bir madde değil.**
>
> Sertifikasyon politikası 300.4.5 ve arm-ttk'nin `apiVersions Should Be Recent` testi
> **730 günlük** sert bir sınır uygular: *"Api versions must be the latest or under 2 years old
> (730 days)"*. Bu dokümanın ilk taslağında `Microsoft.Network` kaynakları `2024-05-01` ile
> yazılmıştı — yazıldığı gün bile **826 günlüktü**, yani sınırı 96 gün aşmıştı ve arm-ttk kırmızı
> verirdi. Aşağıdaki değerler 2026-08-05'te doğrulanmış **en yeni GA** sürümleridir:
>
> | Kaynak tipi | Kullanılan (2026-08-05 itibarıyla en yeni GA) |
> |---|---|
> | `Microsoft.Network/*` | `2025-07-01` |
> | `Microsoft.Compute/virtualMachines` (+ `/extensions`) | `2026-03-01` |
>
> **Her paket üretiminde yeniden doğrulayın** — bu bir öneri değil, `build-azure-package.mjs`'nin
> zorunlu bir doğrulama adımıdır (§5.6):
>
> ```bash
> az provider show -n Microsoft.Compute --query "resourceTypes[?resourceType=='virtualMachines'].apiVersions[]" -o tsv | head -5
> az provider show -n Microsoft.Network --query "resourceTypes[?resourceType=='virtualNetworks'].apiVersions[]" -o tsv | head -5
> ```
>
> En yeni **preview olmayan** sürümü kullanın. Referans sayfalar:
> [Microsoft.Network/virtualNetworks](https://learn.microsoft.com/en-us/azure/templates/microsoft.network/virtualnetworks) ·
> [Microsoft.Compute/virtualMachines](https://learn.microsoft.com/en-us/azure/templates/microsoft.compute/virtualmachines)

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "location": {
      "type": "string",
      "defaultValue": "[resourceGroup().location]",
      "metadata": { "description": "Azure region for all resources." }
    },
    "vmName": {
      "type": "string",
      "defaultValue": "libredb-studio",
      "minLength": 3,
      "maxLength": 40,
      "metadata": { "description": "Name of the virtual machine that hosts LibreDB Studio." }
    },
    "vmSize": {
      "type": "string",
      "defaultValue": "Standard_B2s",
      "metadata": { "description": "Size of the virtual machine." }
    },
    "osDiskSizeGb": {
      "type": "int",
      "defaultValue": 64,
      "minValue": 32,
      "maxValue": 1024,
      "metadata": { "description": "OS disk size in GB. LibreDB Studio stores its SQLite data on this disk." }
    },
    "adminUsername": {
      "type": "string",
      "metadata": { "description": "Linux administrator user name for the virtual machine." }
    },
    "authenticationType": {
      "type": "string",
      "defaultValue": "sshPublicKey",
      "allowedValues": [ "sshPublicKey", "password" ],
      "metadata": { "description": "Authentication type for the Linux administrator account." }
    },
    "adminPasswordOrKey": {
      "type": "securestring",
      "metadata": { "description": "SSH public key or password for the Linux administrator account." }
    },
    "dnsLabelPrefix": {
      "type": "string",
      "defaultValue": "[toLower(concat('libredb-', uniqueString(resourceGroup().id)))]",
      "metadata": { "description": "DNS label for the public IP address. Produces <label>.<region>.cloudapp.azure.com." }
    },
    "appAdminEmail": {
      "type": "string",
      "metadata": { "description": "Email address of the LibreDB Studio administrator account." }
    },
    "appAdminPassword": {
      "type": "securestring",
      "minLength": 12,
      "metadata": { "description": "Password for the LibreDB Studio administrator account. Minimum 12 characters." }
    },
    "enableHttps": {
      "type": "bool",
      "defaultValue": true,
      "metadata": { "description": "Obtain a free Let's Encrypt certificate for the public DNS name and serve the app over HTTPS." }
    },
    "acmeContactEmail": {
      "type": "string",
      "defaultValue": "",
      "metadata": { "description": "Optional contact address sent to Let's Encrypt for certificate expiry notices." }
    },
    "appSourceAddressPrefix": {
      "type": "string",
      "defaultValue": "Internet",
      "metadata": { "description": "Source address prefix allowed to reach the application. With HTTPS enabled this restricts port 443; port 80 stays open to the internet for the Let's Encrypt challenge. With HTTPS disabled it restricts port 80." }
    },
    "sshSourceAddressPrefix": {
      "type": "string",
      "defaultValue": "",
      "metadata": { "description": "Optional source address prefix allowed to reach SSH (port 22). Leave empty to block inbound SSH entirely." }
    }
  },
  "variables": {
    "vnetName": "[concat(parameters('vmName'), '-vnet')]",
    "subnetName": "app",
    "nsgName": "[concat(parameters('vmName'), '-nsg')]",
    "nicName": "[concat(parameters('vmName'), '-nic')]",
    "publicIpName": "[concat(parameters('vmName'), '-pip')]",
    "addressPrefix": "10.10.0.0/16",
    "subnetPrefix": "10.10.1.0/24",
    "subnetRef": "[resourceId('Microsoft.Network/virtualNetworks/subnets', variables('vnetName'), variables('subnetName'))]",
    "imagePublisher": "Canonical",
    "imageOffer": "ubuntu-24_04-lts",
    "imageSku": "server",
    "linuxConfiguration": {
      "disablePasswordAuthentication": true,
      "ssh": {
        "publicKeys": [
          {
            "path": "[concat('/home/', parameters('adminUsername'), '/.ssh/authorized_keys')]",
            "keyData": "[parameters('adminPasswordOrKey')]"
          }
        ]
      }
    },
    "httpsWebRules": [
      {
        "name": "AllowHttpInbound",
        "properties": {
          "priority": 1000, "protocol": "Tcp", "access": "Allow", "direction": "Inbound",
          "sourceAddressPrefix": "Internet", "sourcePortRange": "*",
          "destinationAddressPrefix": "*", "destinationPortRange": "80",
          "description": "Required by the Let's Encrypt HTTP-01 challenge for issuance and renewal; also serves the redirect to HTTPS."
        }
      },
      {
        "name": "AllowHttpsInbound",
        "properties": {
          "priority": 1010, "protocol": "Tcp", "access": "Allow", "direction": "Inbound",
          "sourceAddressPrefix": "[parameters('appSourceAddressPrefix')]", "sourcePortRange": "*",
          "destinationAddressPrefix": "*", "destinationPortRange": "443",
          "description": "The application itself. Restrict this to your own address range if you do not want the interface to be publicly reachable."
        }
      }
    ],
    "httpOnlyWebRules": [
      {
        "name": "AllowHttpInbound",
        "properties": {
          "priority": 1000, "protocol": "Tcp", "access": "Allow", "direction": "Inbound",
          "sourceAddressPrefix": "[parameters('appSourceAddressPrefix')]", "sourcePortRange": "*",
          "destinationAddressPrefix": "*", "destinationPortRange": "80",
          "description": "The application itself, served over plain HTTP."
        }
      }
    ],
    "webRules": "[if(parameters('enableHttps'), variables('httpsWebRules'), variables('httpOnlyWebRules'))]",
    "sshRules": [
      {
        "name": "AllowSshInbound",
        "properties": {
          "priority": 1020, "protocol": "Tcp", "access": "Allow", "direction": "Inbound",
          "sourceAddressPrefix": "[parameters('sshSourceAddressPrefix')]", "sourcePortRange": "*",
          "destinationAddressPrefix": "*", "destinationPortRange": "22"
        }
      }
    ],
    "securityRules": "[if(empty(parameters('sshSourceAddressPrefix')), variables('webRules'), concat(variables('webRules'), variables('sshRules')))]",
    "installScriptB64": "__INSTALL_SCRIPT_B64__"
  },
  "resources": [
    {
      "type": "Microsoft.Network/networkSecurityGroups",
      "apiVersion": "2025-07-01",
      "name": "[variables('nsgName')]",
      "location": "[parameters('location')]",
      "properties": { "securityRules": "[variables('securityRules')]" }
    },
    {
      "type": "Microsoft.Network/virtualNetworks",
      "apiVersion": "2025-07-01",
      "name": "[variables('vnetName')]",
      "location": "[parameters('location')]",
      "dependsOn": [ "[resourceId('Microsoft.Network/networkSecurityGroups', variables('nsgName'))]" ],
      "properties": {
        "addressSpace": { "addressPrefixes": [ "[variables('addressPrefix')]" ] },
        "subnets": [
          {
            "name": "[variables('subnetName')]",
            "properties": {
              "addressPrefix": "[variables('subnetPrefix')]",
              "networkSecurityGroup": { "id": "[resourceId('Microsoft.Network/networkSecurityGroups', variables('nsgName'))]" }
            }
          }
        ]
      }
    },
    {
      "type": "Microsoft.Network/publicIPAddresses",
      "apiVersion": "2025-07-01",
      "name": "[variables('publicIpName')]",
      "location": "[parameters('location')]",
      "sku": { "name": "Standard" },
      "properties": {
        "publicIPAllocationMethod": "Static",
        "publicIPAddressVersion": "IPv4",
        "dnsSettings": { "domainNameLabel": "[parameters('dnsLabelPrefix')]" }
      }
    },
    {
      "type": "Microsoft.Network/networkInterfaces",
      "apiVersion": "2025-07-01",
      "name": "[variables('nicName')]",
      "location": "[parameters('location')]",
      "dependsOn": [
        "[resourceId('Microsoft.Network/virtualNetworks', variables('vnetName'))]",
        "[resourceId('Microsoft.Network/publicIPAddresses', variables('publicIpName'))]"
      ],
      "properties": {
        "ipConfigurations": [
          {
            "name": "ipconfig1",
            "properties": {
              "privateIPAllocationMethod": "Dynamic",
              "subnet": { "id": "[variables('subnetRef')]" },
              "publicIPAddress": { "id": "[resourceId('Microsoft.Network/publicIPAddresses', variables('publicIpName'))]" }
            }
          }
        ]
      }
    },
    {
      "type": "Microsoft.Compute/virtualMachines",
      "apiVersion": "2026-03-01",
      "name": "[parameters('vmName')]",
      "location": "[parameters('location')]",
      "dependsOn": [ "[resourceId('Microsoft.Network/networkInterfaces', variables('nicName'))]" ],
      "properties": {
        "hardwareProfile": { "vmSize": "[parameters('vmSize')]" },
        "storageProfile": {
          "imageReference": {
            "publisher": "[variables('imagePublisher')]",
            "offer": "[variables('imageOffer')]",
            "sku": "[variables('imageSku')]",
            "version": "latest"
          },
          "osDisk": {
            "createOption": "FromImage",
            "diskSizeGB": "[parameters('osDiskSizeGb')]",
            "managedDisk": { "storageAccountType": "StandardSSD_LRS" }
          }
        },
        "osProfile": {
          "computerName": "[parameters('vmName')]",
          "adminUsername": "[parameters('adminUsername')]",
          "adminPassword": "[parameters('adminPasswordOrKey')]",
          "linuxConfiguration": "[if(equals(parameters('authenticationType'), 'password'), null(), variables('linuxConfiguration'))]"
        },
        "networkProfile": {
          "networkInterfaces": [ { "id": "[resourceId('Microsoft.Network/networkInterfaces', variables('nicName'))]" } ]
        },
        "diagnosticsProfile": { "bootDiagnostics": { "enabled": true } }
      }
    },
    {
      "type": "Microsoft.Compute/virtualMachines/extensions",
      "apiVersion": "2026-03-01",
      "name": "[concat(parameters('vmName'), '/installLibreDBStudio')]",
      "location": "[parameters('location')]",
      "dependsOn": [ "[resourceId('Microsoft.Compute/virtualMachines', parameters('vmName'))]" ],
      "properties": {
        "publisher": "Microsoft.Azure.Extensions",
        "type": "CustomScript",
        "typeHandlerVersion": "2.1",
        "autoUpgradeMinorVersion": true,
        "protectedSettings": {
          "commandToExecute": "[concat('echo ', variables('installScriptB64'), ' | base64 -d > /opt/libredb-install.sh && chmod 700 /opt/libredb-install.sh && /opt/libredb-install.sh ', base64(parameters('appAdminEmail')), ' ', base64(parameters('appAdminPassword')), ' ', base64(if(parameters('enableHttps'), reference(resourceId('Microsoft.Network/publicIPAddresses', variables('publicIpName'))).dnsSettings.fqdn, ':80')), ' ', base64(parameters('acmeContactEmail')), ' ', base64(parameters('appSourceAddressPrefix')))]"
        }
      }
    }
  ],
  "outputs": {
    "applicationUrl": {
      "type": "string",
      "value": "[if(parameters('enableHttps'), concat('https://', reference(resourceId('Microsoft.Network/publicIPAddresses', variables('publicIpName'))).dnsSettings.fqdn), concat('http://', reference(resourceId('Microsoft.Network/publicIPAddresses', variables('publicIpName'))).ipAddress))]"
    },
    "notes": {
      "type": "string",
      "value": "[if(parameters('enableHttps'), if(equals(parameters('appSourceAddressPrefix'), 'Internet'), concat('If the TLS certificate could not be issued, the installer serves the application over plain HTTP at http://', reference(resourceId('Microsoft.Network/publicIPAddresses', variables('publicIpName'))).ipAddress, ' and records the reason in /etc/libredb-studio.info on the virtual machine.'), 'If the TLS certificate could not be issued, the installer keeps the application on port 443 with a self-signed certificate so that your source restriction is never widened; your browser will warn you. The reason is recorded in /etc/libredb-studio.info on the virtual machine.'), 'The application is served over plain HTTP. Put a TLS terminating gateway in front of it before exposing it beyond a trusted network.')]"
    },
    "administratorEmail": { "type": "string", "value": "[parameters('appAdminEmail')]" },
    "sshCommand": {
      "type": "string",
      "value": "[if(empty(parameters('sshSourceAddressPrefix')), 'Inbound SSH is blocked by the network security group. Use Azure Bastion or the serial console, or add an SSH rule afterwards.', concat('ssh ', parameters('adminUsername'), '@', reference(resourceId('Microsoft.Network/publicIPAddresses', variables('publicIpName'))).dnsSettings.fqdn))]"
    }
  }
}
```

> **Yorum satırı yok — bilerek.** Yukarıdaki blok geçerli JSON'dur ve öyle kalmalıdır: ARM
> template'lerinde yorum satırları sertifikasyonda sorun çıkarabilir; Microsoft'un kendi örneğinde
> bile *"remove all comments from the file when complete"* uyarısı var. Açıklamalarınızı
> `metadata.description` alanlarına yazın.

> **Kritik:** `outputs` bölümüne **asla parola koymayın** — arm-ttk'nin
> "Outputs Must Not Contain Secrets" testi bunu yakalar ve sertifikasyonu düşürür.

### 5.5 `deploy/azure/src/createUiDefinition.json`

```json
{
  "$schema": "https://schema.management.azure.com/schemas/0.1.2-preview/CreateUIDefinition.MultiVm.json#",
  "handler": "Microsoft.Azure.CreateUIDef",
  "version": "0.1.2-preview",
  "parameters": {
    "basics": [
      {
        "name": "vmName",
        "type": "Microsoft.Common.TextBox",
        "label": "Virtual machine name",
        "defaultValue": "libredb-studio",
        "toolTip": "Name of the virtual machine that will run LibreDB Studio.",
        "constraints": {
          "required": true,
          "regex": "^[a-z][a-z0-9-]{1,38}[a-z0-9]$",
          "validationMessage": "3-40 characters: lowercase letters, numbers and hyphens; must start with a letter and must not end with a hyphen."
        }
      },
      {
        "name": "adminUsername",
        "type": "Microsoft.Compute.UserNameTextBox",
        "label": "Linux admin username",
        "toolTip": "Administrator account used for SSH access to the virtual machine.",
        "osPlatform": "Linux",
        "constraints": { "required": true }
      },
      {
        "name": "adminCredentials",
        "type": "Microsoft.Compute.CredentialsCombo",
        "label": {
          "authenticationType": "Authentication type",
          "password": "Password",
          "confirmPassword": "Confirm password",
          "sshPublicKey": "SSH public key"
        },
        "toolTip": {
          "authenticationType": "SSH public key is strongly recommended.",
          "password": "Password for the Linux administrator account.",
          "sshPublicKey": "Paste an OpenSSH public key."
        },
        "constraints": { "required": true },
        "options": { "hideConfirmation": false },
        "osPlatform": "Linux"
      }
    ],
    "steps": [
      {
        "name": "vmConfig",
        "label": "Virtual machine",
        "elements": [
          {
            "name": "vmSize",
            "type": "Microsoft.Compute.SizeSelector",
            "label": "Virtual machine size",
            "toolTip": "LibreDB Studio runs comfortably on 2 vCPU / 4 GB RAM.",
            "recommendedSizes": [ "Standard_B2s", "Standard_B2ms", "Standard_D2s_v5" ],
            "options": { "hideDiskTypeFilter": false },
            "osPlatform": "Linux",
            "imageReference": {
              "publisher": "Canonical",
              "offer": "ubuntu-24_04-lts",
              "sku": "server"
            },
            "count": 1,
            "visible": true
          },
          {
            "name": "osDiskSizeGb",
            "type": "Microsoft.Common.Slider",
            "min": 32,
            "max": 1024,
            "label": "OS disk size (GB)",
            "subLabel": "GB",
            "defaultValue": 64,
            "showStepMarkers": false,
            "toolTip": "LibreDB Studio keeps its SQLite storage on the OS disk.",
            "constraints": { "required": false },
            "visible": true
          },
          {
            "name": "dnsLabelPrefix",
            "type": "Microsoft.Common.TextBox",
            "label": "DNS name label",
            "toolTip": "Produces <label>.<region>.cloudapp.azure.com. Must be unique inside the region.",
            "constraints": {
              "required": true,
              "regex": "^[a-z][a-z0-9-]{1,61}[a-z0-9]$",
              "validationMessage": "3-63 characters: lowercase letters, numbers and hyphens; must start with a letter and end with a letter or number."
            }
          }
        ]
      },
      {
        "name": "appConfig",
        "label": "LibreDB Studio",
        "elements": [
          {
            "name": "appAdminEmail",
            "type": "Microsoft.Common.TextBox",
            "label": "Application administrator email",
            "defaultValue": "",
            "toolTip": "The email address you will sign in to LibreDB Studio with.",
            "constraints": {
              "required": true,
              "regex": "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
              "validationMessage": "Enter a valid email address."
            }
          },
          {
            "name": "appAdminPassword",
            "type": "Microsoft.Common.PasswordBox",
            "label": { "password": "Application administrator password", "confirmPassword": "Confirm password" },
            "toolTip": "Password for the LibreDB Studio administrator account (not the VM account).",
            "constraints": {
              "required": true,
              "regex": "^[A-Za-z0-9!@#%^*_+=.,:?-]{12,64}$",
              "validationMessage": "12-64 characters. Letters, digits and ! @ # % ^ * _ + = . , : ? - are allowed."
            },
            "options": { "hideConfirmation": false },
            "visible": true
          },
          {
            "name": "enableHttps",
            "type": "Microsoft.Common.OptionsGroup",
            "label": "Enable HTTPS with a free Let's Encrypt certificate",
            "defaultValue": "Yes",
            "toolTip": "Issues a certificate for the DNS name above. Requires inbound port 80 to be reachable from the internet.",
            "constraints": {
              "allowedValues": [
                { "label": "Yes", "value": true },
                { "label": "No (HTTP only)", "value": false }
              ],
              "required": true
            }
          },
          {
            "name": "acmeContactEmail",
            "type": "Microsoft.Common.TextBox",
            "label": "Certificate contact email (optional)",
            "defaultValue": "",
            "toolTip": "Sent to Let's Encrypt for expiry notices.",
            "constraints": {
              "required": false,
              "regex": "^$|^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
              "validationMessage": "Leave empty or enter a valid email address."
            },
            "visible": "[equals(steps('appConfig').enableHttps, true)]"
          }
        ]
      },
      {
        "name": "networkConfig",
        "label": "Network access",
        "elements": [
          {
            "name": "appSourceAddressPrefix",
            "type": "Microsoft.Common.TextBox",
            "label": "Allowed source for the web interface",
            "defaultValue": "Internet",
            "toolTip": "Use 'Internet' for public access, or a CIDR such as 203.0.113.0/24 to restrict it.",
            "constraints": {
              "required": true,
              "regex": "^(Internet|VirtualNetwork|AzureLoadBalancer|(\\d{1,3}\\.){3}\\d{1,3}(/\\d{1,2})?)$",
              "validationMessage": "Enter 'Internet' or an IPv4 address / CIDR range."
            }
          },
          {
            "name": "httpsPortNotice",
            "type": "Microsoft.Common.InfoBox",
            "visible": "[equals(steps('appConfig').enableHttps, true)]",
            "options": {
              "icon": "Info",
              "text": "This restriction applies to port 443, where the application is served. Port 80 stays open to the internet so that Let's Encrypt can issue and renew the certificate; it serves the challenge and a redirect to HTTPS. If you restrict the range and no certificate can be issued, the installer keeps the application on port 443 with a self-signed certificate rather than moving it to port 80, so your restriction is never widened."
            }
          },
          {
            "name": "sshSourceAddressPrefix",
            "type": "Microsoft.Common.TextBox",
            "label": "Allowed source for SSH (optional)",
            "defaultValue": "",
            "toolTip": "Leave empty to block inbound SSH completely. Azure Bastion or the serial console can still be used.",
            "constraints": {
              "required": false,
              "regex": "^$|^((\\d{1,3}\\.){3}\\d{1,3}(/\\d{1,2})?)$",
              "validationMessage": "Leave empty or enter an IPv4 address / CIDR range."
            }
          },
          {
            "name": "sshWarning",
            "type": "Microsoft.Common.InfoBox",
            "visible": "[empty(steps('networkConfig').sshSourceAddressPrefix)]",
            "options": {
              "icon": "Info",
              "text": "Inbound SSH will be blocked. You can still manage the VM with Azure Bastion or the serial console, and you can add an SSH rule to the network security group later."
            }
          }
        ]
      }
    ],
    "outputs": {
      "location": "[location()]",
      "vmName": "[basics('vmName')]",
      "adminUsername": "[basics('adminUsername')]",
      "authenticationType": "[basics('adminCredentials').authenticationType]",
      "adminPasswordOrKey": "[coalesce(basics('adminCredentials').password, basics('adminCredentials').sshPublicKey)]",
      "vmSize": "[steps('vmConfig').vmSize]",
      "osDiskSizeGb": "[steps('vmConfig').osDiskSizeGb]",
      "dnsLabelPrefix": "[steps('vmConfig').dnsLabelPrefix]",
      "appAdminEmail": "[steps('appConfig').appAdminEmail]",
      "appAdminPassword": "[steps('appConfig').appAdminPassword]",
      "enableHttps": "[steps('appConfig').enableHttps]",
      "acmeContactEmail": "[steps('appConfig').acmeContactEmail]",
      "appSourceAddressPrefix": "[steps('networkConfig').appSourceAddressPrefix]",
      "sshSourceAddressPrefix": "[steps('networkConfig').sshSourceAddressPrefix]"
    }
  }
}
```

> ⚠️ **Buradaki regex'ler ve kontrol şemaları portal sandbox'ında doğrulanmadan kabul edilmemeli**
> (§6.1, kontrol 2.3). Bir regex hatası veya yanlış kontrol özelliği sihirbazı çalışmaz hale getirir
> ve bunu ancak sandbox gösterir.
>
> İki bilinçli karar: (1) `Microsoft.Compute.SizeSelector` içinde `constraints.allowedSizes`
> **verilmedi** — boş bir liste müşteriye hiçbir VM boyutu göstermez; boyut kısıtlamak isterseniz
> gerçek bir SKU listesi yazın (kural 300.4.8: izin verilen boyutlar seçilen disk tipiyle uyumlu
> olmalı). (2) `createUiDefinition.json` **gerçek JSON'dur, yorum satırı içeremez.**

### 5.6 `scripts/build-azure-package.mjs`

Paketi üreten script. Repo'daki mevcut desenlerle uyumlu (Node, `node:` modülleri, ESM).

**Yapması gerekenler:**

1. `package.json`'dan sürümü oku.
2. `ghcr.io/libredb/libredb-studio:<sürüm>` etiketinin **manifest digest**'ini çöz.
   (Repo'da bu zaten çözülüyor: `scripts/distribution-check.mjs` içindeki `ghcr-tag-digest` probe'u —
   anonim token + `GET https://ghcr.io/v2/libredb/libredb-studio/manifests/<ref>` + `docker-content-digest`
   header'ı. Aynı mantığı yeniden kullanın, kopyalamayın: ortak yardımcıyı `scripts/lib/` altına taşıyın.)
3. `install.sh` içindeki `__APP_IMAGE__` ve `__CADDY_IMAGE__` placeholder'larını doldur.
4. Doldurulmuş script'i base64'le, `mainTemplate.json` içindeki `__INSTALL_SCRIPT_B64__` yerine koy.
5. Çıktıları `dist/azure/package/` altına yaz (`mainTemplate.json`, `createUiDefinition.json`).
6. **`apiVersion` yaş kontrolü (iki eşikli kapı).** `mainTemplate.json` içindeki **yalnızca
   `"apiVersion"` anahtarlarının** değerlerini ayrıştır ve yaşlarına göre davran:

   | Yaş | Davranış |
   |---|---|
   | < 540 gün | sessiz geç |
   | **540–700 gün** | **uyarı bas, build devam etsin** — *"apiVersion X gün yaşında; 700 günde kapı kapanır, tazele"* |
   | **≥ 700 gün** | **hata verip çık** |

   Neden tek sert eşik değil: 730 politika sınırına yakın üretilmiş bir paket, Microsoft haftalarca
   inceleme yaparken yaşlanıp sınırı geçebilir — tampon şart. Ama tek başına 540, gerçek duvardan
   ~190 gün önce kapanıp kullanılabilir tamponu çöpe atar ve hiç erken uyarı vermez. 700, politika
   sınırına 30 gün bırakır (tipik bir sertifikasyon süresi için yeterli) ve uyarı dalı aylar
   öncesinden dürter.
   ⚠️ **`$schema` ve `contentVersion` bu taramanın dışındadır.** `$schema` içindeki `2019-04-01`
   bir apiVersion değildir; doğrudur ve **değişmemelidir** (arm-ttk'nin
   `DeploymentTemplate Schema Is Correct` testi kaynak-grubu deployment'ları için tam olarak bunu
   bekler). "Tarih benzeri her literali tara" şeklinde uygulanırsa kapı her çalıştırmada boşuna düşer.

   Bu adım, ilk taslakta `Microsoft.Network` sürümlerinin yazıldığı gün bile 826 günlük olması
   hatasının **yapısal olarak tekrarlanmasını engeller** (B1).

   **Kapının ne zaman devreye gireceği belli** — sürpriz olmasın diye takvime yazın:

   | apiVersion | 540: uyarı başlar | **700: build durur** | 730 politika sınırı |
   |---|---|---|---|
   | `2025-07-01` (Network) | 2026-12-23 | **2027-06-01** | 2027-07-01 |
   | `2026-03-01` (Compute) | 2027-08-23 | **2028-01-30** | 2028-02-29 |

   Yani ~2026 Aralık sonunda workflow **uyarmaya başlar**, ~2027 Mayıs sonunda **durur**. İkisi de
   istenen davranıştır: "workflow bozuldu" değil, "apiVersion'ları tazele" demektir.

   > **Kalıcı alternatif (ilk yayın için önerilmez):** `apiVersion`'ları hiç sabit yazmayıp build
   > anında `az provider show` ile en yeni GA'yı çözmek. Kapı tamamen gereksizleşir. Bedeli: CI'da
   > Azure CLI + kimlik doğrulama gerekir (workflow şu an hiç Azure erişimi olmadan,
   > `permissions: contents: read` ile çalışıyor) ve paket deterministik olmaktan çıkar — her build
   > test edilmemiş bir şema sürümü getirebilir. Kanal olgunlaştığında yeniden değerlendirin.
7. Bu klasörü **kökünde iki dosya olacak şekilde** zip'le:
   `dist/azure/libredb-studio-azure-<paket-sürümü>.zip`.
8. Paket sürümünü (`X.Y.Z`, Partner Center'a girilecek) ve zip yolunu stdout'a yazdır.

**Kritik kurallar:**
- Zip içinde **alt klasör olmayacak**; iki dosya zip kökünde olacak (F4).
- Zip'e **binary konulmayacak** (F5).
- Partner Center'daki "Version" alanı `tamsayı.tamsayı.tamsayı` formatında olmalı ve **her yayında
  artırılmalı**. Uygulama sürümüyle karıştırmayın: uygulama `0.9.66` iken paket `1.0.0` olabilir.
  Öneri: paket sürümünü ayrı tutun ve `deploy/azure/package-version.txt` içinde saklayın; imaj
  sürümü `mainTemplate.json`'a gömülü olduğu için uygulama sürümü değiştiğinde paket sürümü de artar.

> **🤖 Test zorunlu — repo konvansiyonu.** `scripts/` altındaki **her** `.mjs`'in birebir bir unit
> testi var (`distribution-check`, `sync-chart-version`, `merge-lcov`, `check-coverage`,
> `copy-monaco`, `render-*` — istisnasız sekizde sekiz). `CLAUDE.md`: *"100% line coverage is a
> hard CI gate — work TDD, always"*. Bu yüzden bu script **`tests/unit/build-azure-package.test.ts`
> ile birlikte** aynı PR'da gelmelidir; en az şunları doğrulasın: digest çözümü, placeholder
> doldurma, zip kökünde tam iki dosya, ve **yaş kapısının her iki dalı**: ~600 günlük bir değerde
> build'in **geçtiği ama uyarı bastığı**, ~710 günlükte **hata verdiği**.
>
> **Yardımcı modülün yeri.** GHCR digest çözümünü `scripts/lib/` altına taşımak caziptir, ama
> `knip.json`'ın `entry`/`project` glob'ları **`scripts/*.mjs`** (tek yıldız) — `scripts/lib/*.mjs`
> knip'in ve dolayısıyla coverage görünürlüğünün dışında kalır. Knip patlamaz ama modül denetimsiz
> kalır. Bu yüzden ya glob'u genişletin ya da yardımcıyı `scripts/distribution-check.mjs`'nin de
> import ettiği bir modül olarak kurgulayıp mevcut testin kapsamında tutun.

### 5.7 `.github/workflows/azure-marketplace-package.yml`

```yaml
name: Azure Marketplace Package

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'App version to pin (must exist on ghcr.io/libredb/libredb-studio, e.g. 0.9.66)'
        required: true
      packageVersion:
        description: 'Marketplace package version (integer.integer.integer, must be higher than the last published one)'
        required: true

permissions:
  contents: read

jobs:
  package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6

      # Build script'i bağımlılıksız düz Node'dur; runner'daki Node yeterli,
      # `bun install` gerekmez.
      - name: Build package
        run: node scripts/build-azure-package.mjs --version "${{ inputs.version }}" --package-version "${{ inputs.packageVersion }}"

      - name: Download ARM template test toolkit
        run: |
          curl -fsSLo arm-ttk.zip https://github.com/Azure/arm-ttk/releases/latest/download/arm-ttk.zip
          unzip -q arm-ttk.zip -d arm-ttk

      - name: Run marketplace validation
        shell: pwsh
        run: |
          Import-Module ./arm-ttk/arm-ttk/arm-ttk.psd1
          $results = Test-AzMarketplacePackage -TemplatePath "dist/azure/package"
          $results | Format-List
          $failed = $results | Where-Object { $_.Errors }
          if ($failed) { Write-Error "arm-ttk reported $($failed.Count) failing test(s)"; exit 1 }

      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: libredb-studio-azure-package
          path: dist/azure/*.zip
          if-no-files-found: error
```

> `ubuntu-latest` runner'larında PowerShell (`pwsh`) kurulu gelir; ayrıca kurulum gerekmez.
> arm-ttk yolu **doğrulandı** (2026-02-13 release'i): tek asset `arm-ttk.zip`, içindeki yol
> `arm-ttk/arm-ttk/arm-ttk.psd1`. Job bir gün kırılırsa ilk olarak asset adının değişmiş olma
> ihtimalini kontrol edin: <https://github.com/Azure/arm-ttk/releases>
>
> `actions/upload-artifact@v4` yerine repo'da hâlihazırda kullanılan pinli sürümü yazın:
> `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4` (`.github/workflows/ci.yml:138`).
> Repo'da pinleme **çoğunlukta ama mutlak değil** — `actions/checkout@v4`, `actions/github-script@v7`
> gibi pinsiz kullanımlar da var; yine de yeni workflow'u pinli yazın.

---

## 6. Faz 2 — Yerel doğrulama ve gerçek Azure testi

Bu fazın tamamı **Partner Center'a dokunmadan** yapılır. Buradaki her adım geçmeden Faz 3'e geçmeyin.

> **Kim:** 🤖 statik doğrulama ve deployment komutları AI'da; 🧑 **portal sandbox'ı (kontrol 2.3)**
> ve Azure aboneliğinin sağlanması insanda. AI'ya `az login` yapılmış bir terminal verilirse §6.2
> testlerini de AI koşturabilir — verilmiyorsa komutları AI hazırlar, insan çalıştırır ve çıktıyı
> AI'ya yorumlatır.

### 6.1 Statik doğrulama

| # | Kontrol | Komut / yer | Kim |
|---|---|---|---|
| 2.1 | JSON sözdizimi | `node -e "JSON.parse(require('fs').readFileSync('dist/azure/package/mainTemplate.json','utf8'))"` | 🤖 |
| 2.2 | **arm-ttk Marketplace testleri — kırmızı sonuç sıfır olmalı** | `Test-AzMarketplacePackage -TemplatePath "dist/azure/package"` | 🤖 |
| 2.3 | **createUiDefinition portal sandbox** — sihirbazın gerçek görünümü | <https://portal.azure.com/#view/Microsoft_Azure_CreateUIDef/SandboxBlade> içine dosyayı yapıştır → Preview | 🧑 |
| 2.4 | Sandbox çıktısındaki `outputs` objesinin `mainTemplate.json` parametreleriyle **birebir** eşleştiği (isim ve tip) | AI karşılaştırma script'i / gözle | 🤖 |
| 2.5 | Zip yapısı: kökte tam 2 dosya | `unzip -l dist/azure/*.zip` | 🤖 |
| 2.6 | `install.sh` shell lint | `shellcheck deploy/azure/src/install.sh` | 🤖 |
| 2.7 | **`apiVersion` yaşı** — hata dalı (≥700) tetiklenmiyor, uyarı dalı (≥540) çıktısı okundu | `build-azure-package.mjs`'nin yaş kapısı (§5.6, adım 6) | 🤖 |
| 2.8 | `scripts/build-azure-package.mjs` birim testi geçiyor mu | `bun run test:unit` | 🤖 |
| 2.9 | **Caddyfile sözdizimi + gerçek issuer listesi.** Önce `caddy validate`, sonra `caddy adapt` çıktısındaki issuer'ları sayın — **tek ACME issuer** görünüyorsa bu, §5.1'deki "tek CA" kararının fiilen yürürlükte olduğunun kanıtıdır (R4'ün olasılığı buna göre ayarlandı). Beklenmedik bir liste çıkarsa kararı yeniden değerlendirin | `docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` ve `… caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile \| grep -o '"issuer[^,]*' \| sort -u` (üretilmiş Caddyfile'ı `install.sh`'i yerel koşturarak elde edin) | 🤖 |

### 6.2 Gerçek deployment testi (kendi aboneliğimizde)

```bash
RG=libredb-mp-test-$RANDOM
az group create -n "$RG" -l westeurope

az deployment group create \
  -g "$RG" \
  --template-file dist/azure/package/mainTemplate.json \
  --parameters \
      adminUsername=azureuser \
      authenticationType=sshPublicKey \
      adminPasswordOrKey="$(cat ~/.ssh/id_ed25519.pub)" \
      appAdminEmail=admin@libredb.org \
      appAdminPassword='ChangeMe.2026!' \
      dnsLabelPrefix="libredb-test-$RANDOM" \
      sshSourceAddressPrefix="$(curl -s https://api.ipify.org)/32"

az deployment group show -g "$RG" -n mainTemplate --query properties.outputs
```

**Kabul kriterleri (hepsi geçmeli):**

- [ ] Deployment `Succeeded` (CustomScript extension dahil) — tipik yol ~5 dakika. **Tavan ~15 dakika:**
      kurulum artık sertifikayı deployment bitmeden doğruluyor (180 sn) ve gerekirse düz HTTP'ye
      (kısıtsız kurulum) veya self-signed HTTPS'e (kısıtlı kurulum) düşüyor (+120 sn); apt kilidi ve
      imaj çekme yeniden denemeleri de üstüne binebilir
- [ ] `applicationUrl` çıktısı tarayıcıda açılıyor ve **geçerli bir HTTPS sertifikası** sunuyor
- [ ] Girilen `appAdminEmail` / `appAdminPassword` ile giriş yapılıyor
- [ ] `GET https://<fqdn>/api/db/health` → **`{"status":"healthy","timestamp":"…","service":"libredb-studio"}`**
      (`src/app/api/db/health/route.ts`; otomatik assertion yazacaksanız `.status == "healthy"`)
- [ ] Gömülü örnek bağlantılar ("Sample (LibreDB)", "Sample (Employees)") çalışıyor
- [ ] VM restart sonrası uygulama otomatik geliyor (`systemctl is-enabled libredb-studio` → enabled) ve **veriler duruyor**
- [ ] `sshSourceAddressPrefix` boş bırakılan bir deployment'ta 22 portu **kapalı** (`nc -zv <ip> 22` timeout)
- [ ] 3000 portu **dışarıdan kapalı** (`nc -zv <ip> 3000` timeout), içeriden açık
- [ ] `/etc/libredb-studio.env` mode `0600`
- [ ] `enableHttps=false` + `appSourceAddressPrefix=<kendi IP>/32` ile ikinci bir deployment:
      HTTP 80'de yalnızca o IP'den erişilebiliyor
- [ ] `authenticationType=password` ile üçüncü bir deployment: sorunsuz
- [ ] Aynı template ile **ikinci bir bölgede** (ör. `eastus`) deployment: sorunsuz
- [ ] **HTTPS + kaynak kısıtı birlikte çalışıyor:** `enableHttps=true appSourceAddressPrefix=<kendi IP>/32`
      ile deploy edin. Beklenen: **sertifika sorunsuz alınır** (80 `Internet`'e açık kaldığı için) ve
      uygulamaya yalnızca o IP'den HTTPS ile erişilebilir; başka bir ağdan 443 timeout verir
- [ ] **TLS düşüş senaryosu (B4).** Bu yol artık template parametresiyle **tetiklenemez** — N1 düzeltmesi
      en olası sebebi ortadan kaldırdı. Kalan sebepler (LE rate limit / kesinti / müşterinin sonradan
      araya soktuğu güvenlik duvarı) için yolu elle simüle edin:
      **Komutlar iki ayrı makinede çalışır — karıştırmayın.**

      ```bash
      # ============ İŞ İSTASYONUNDA (az CLI + oturum) ============
      # 1) normal bir HTTPS deployment'ı tamamlayın, sonra 80'i dışarıya kapatın
      az network nsg rule create -g "$RG" --nsg-name libredb-studio-nsg \
        -n DenyAcme --priority 900 --access Deny --direction Inbound \
        --protocol Tcp --destination-port-ranges 80 --source-address-prefixes Internet

      # 2) VM'e geçmeden önce gerçek FQDN'i buradan okuyup not edin
      az network public-ip show -g "$RG" -n libredb-studio-pip \
        --query dnsSettings.fqdn -o tsv
      ```

      > ⚠️ **Aşağıdaki bloğu kopyalarken satır başlarındaki girintiyi atın.** `<<'VMBLOCK'`
      > heredoc'unun sonlandırıcısı **satır başında, önünde tek boşluk bile olmadan** durmak zorunda.
      > Render edilmiş markdown'dan kopyalarsanız girinti zaten gitmiş olur; **ham dosyadan**
      > kopyalarsanız (bu doküman bir AI asistanına ham okutuluyor) `VMBLOCK` satırı girintili kalır
      > ve bash heredoc'u hiç sonlandıramaz — `warning: here-document delimited by end-of-file`.
      > `<<-` işe yaramaz: yalnızca **tab** siler, boşluk silmez.

      ```bash
      # ============ VM'DE (SSH veya seri konsol) ============
      # Blok tek parça çalışsın diye `sudo bash` heredoc'una sarıldı. İki faydası var:
      #   1) İçerideki `exit 1` yalnızca bu alt kabuğu bitirir — interaktif bir SSH
      #      oturumunda çıplak `exit 1` OTURUMU KAPATIRDI ve kalan satırlar yerel
      #      kabuğa düşerdi.
      #   2) Yapıştırma atomik olur, yarısı çalışıp yarısı kaybolmaz.
      # sudo parolası terminalden (/dev/tty) okunur, stdin'den değil — heredoc bunu bozmaz.
      sudo bash <<'VMBLOCK'
      # FQDN'i iş istasyonu bloğunun yazdırdığı değerden DÜZ METİN olarak yapıştırmak
      # asıl yoldur. Aşağıdaki okuma yedek yoldur ve yalnızca TEMİZ bir HTTPS kurulumunda
      # çalışır:
      #   * `hostname -f` KULLANMAYIN — Azure'da İÇ adı döndürür (<vm>.internal.cloudapp.net)
      #     ve test, ACME'nin iç ada sertifika vermemesi yüzünden YANLIŞ SEBEPLE geçer.
      #   * Desende `https` bilerek sabit: `https\?` olsaydı düşüş sonrası FQDN yerine IP
      #     döndürürdü. Bunun bedeli, `Internet` dalına düşülmüş bir VM'de bu okumanın
      #     BOŞ dönmesidir — bu yüzden aşağıdaki koruma zorunlu.
      # FQDN_OVERRIDE ile dışarıdan verilebilir: ikinci koşuda bloğu düzenlemek yerine
      #   sudo FQDN_OVERRIDE=<ilk-koşudaki-fqdn> bash <<'VMBLOCK'
      # yazmanız yeterli; blok hiç değişmez.
      FQDN="${FQDN_OVERRIDE:-$(sed -n 's#^  URL:  *https://##p' /etc/libredb-studio.info)}"
      # Koruma: FQDN boş kalırsa 3. argüman boş gider, install.sh SITE_ADDRESS=":80"
      # varsayar, TLS bloğu HİÇ çalışmaz ve test "geçti" der — hiçbir şey doğrulamadan.
      [ -n "$FQDN" ] || { echo "FQDN okunamadi — is istasyonu ciktisindan yapistirin" >&2; exit 1; }

      systemctl stop libredb-caddy
      rm -rf /opt/libredb/caddy/data/*
      systemctl start libredb-caddy

      # BEŞ argümanın hepsini geçin. 5. argüman eksik kalırsa script kısıtsız varsayar,
      # düz HTTP dalına düşer ve testin doğrulaması gereken dalı sessizce atlar.
      # -w0: GNU base64 76 kolonda kaydırır; ARM'ın base64() fonksiyonu kaydırmaz.
      /opt/libredb-install.sh \
        "$(printf admin@libredb.org  | base64 -w0)" \
        "$(printf 'ChangeMe.2026!'   | base64 -w0)" \
        "$(printf '%s' "$FQDN"       | base64 -w0)" \
        "$(printf ''                 | base64 -w0)" \
        "$(printf '203.0.113.0/24'   | base64 -w0)"     # kısıtlı dalı zorlar
      VMBLOCK
      ```
      Beklenen (**kısıtlı dal**): script **başarısız olmaz**, uygulama `:80`'e **taşınmaz**,
      `:443`'te **self-signed** sertifikayla kalır, `/etc/libredb-studio.info` + MOTD içinde
      "was NOT moved to port 80" uyarısı çıkar, `Caddyfile.https` yedeği oluşur.

      Aynı testi 5. argüman `Internet` ile tekrarlayın: bu kez `:80`'e düşmeli.
      ⚠️ İkinci koşuda bloğu **olduğu gibi** çalıştırın ama FQDN'i dışarıdan verin:
      `sudo FQDN_OVERRIDE=<ilk-koşudaki-fqdn> bash <<'VMBLOCK'`. İlk koşudan sonra info dosyası
      `http://<ip>` yazabilir; override vermezseniz okuma boş döner ve koruma testi sessizce
      geçirmek yerine durdurur
- [ ] **Kurtarma yolunu da test edin** — planın en az yürünmüş yolu burası, ve ona her dokunulduğunda
      yeni bir pürüz çıktı. Düşüş oluştuktan sonra sırayla:

      > 🔴 **Önce şunu okuyun: (e) adımını AYNI hostname üzerinde koşturmayın.** Let's Encrypt
      > başarısız doğrulamaları **identifier (hostname) başına saatlik** bir bütçeyle sınırlar
      > (bugün 5/saat). Bu bütçeyi tüketen şey **yukarıdaki simülasyondur** — özellikle iki
      > koşu, her biri 180 sn boyunca yeniden deneyerek — artı aşağıdaki **(c)** adımındaki
      > erken geri yükleme. ((a) `ls` ve (b) `docker logs` salt okumadır, hiçbir şey harcamaz;
      > yani "onları atlarsam bütçe korunur" diye düşünmeyin, bütçe testten önce zaten
      > harcanmıştır.) Sonuç: aynı hostname'de (e) **kurtarmayla ilgisi olmayan** bir sebepten
      > düşer ve test sizi yanlış yöne sürer.
      >
      > **Bu yüzden (e), taze bir `dnsLabelPrefix` ile yapılan yeni bir deployment üzerinde
      > düşüş durumunu YENİDEN ÜRETEREK koşulur** (aşağıdaki e0–e4). Limit hostname başına
      > olduğu için bütçe sıfırlanır.
      >
      > **Alternatif — tüm simülasyonu tekrarlanabilir kılar (ek yapılandırma ister):** (a)–(d)'yi
      > LE **staging** dizinine alın. ⚠️ Bunu global `acme_ca` seçeneğiyle yapmaya çalışmayın:
      > `acme_ca` **varsayılan** issuer'ları yapılandırır, oysa bizim ürettiğimiz Caddyfile sitenin
      > kendi **açık** `issuer acme` bloğunu ilan ediyor — global kısayol orada en iyi ihtimalle
      > belirsiz, pratikte etkisizdir ve istekler **sessizce üretime** gider (yani kaçınmak
      > istediğiniz rate limit'i alırsınız). Doğrusu dizini **issuer bloğunun içine** yazmaktır:
      >
      > ```
      > tls {
      >     issuer acme {
      >         dir https://acme-staging-v02.api.letsencrypt.org/directory
      >         email <acme-contact>
      >         disable_tlsalpn_challenge
      >     }
      > }
      > ```
      >
      > Pratikte: `install.sh`'in Caddyfile üretecine geçici bir `dir` satırı ekleyin ya da testten
      > önce `/opt/libredb/caddy/Caddyfile`'ı elle düzenleyip Caddy'yi yeniden başlatın. Staging
      > limitleri çok daha geniştir ve staging sertifikası güvenilmez olduğu için kurulumun
      > `curl -fsS` kontrolü zaten başarısız olup düşüşü tetikler — test için kusur değil, kolaylık.

      | # | Adım | Nerede | Beklenen |
      |---|---|---|---|
      | (a) | `ls -l /opt/libredb/caddy/Caddyfile.fallback` | VM | Dosya **kurulum tarafından** yazılmış (operatör eli değmeden) |
      | (b) | `docker logs libredb-caddy 2>&1 \| grep -i -m5 'acme\|challenge\|rate limit'` | VM | Gerçek ACME hatasını gösteriyor (bağlantı hatası mı, rate limit mi) |
      | (c) | `sudo cp /opt/libredb/caddy/Caddyfile.https /opt/libredb/caddy/Caddyfile && sudo systemctl restart libredb-caddy` | VM | **Erken geri yükleme**, 80 hâlâ kapalıyken: `:443` TLS el sıkışması başarısız olur, `:80` yalnızca ölü bir adrese 308 yönlendirir (yani 80 **yanıt verir** ama site kullanılamaz) |
      | (d) | `sudo cp /opt/libredb/caddy/Caddyfile.fallback /opt/libredb/caddy/Caddyfile && sudo systemctl restart libredb-caddy` | VM | Çalışan düşüş geri gelir — kaçış kapısı gerçekten çalışıyor |

      **(e) taze bir hostname'de düşüşü yeniden üretir** — eski gruptaki `DenyAcme`'i silmek
      işe yaramaz, çünkü yeni deployment'ın NSG'sinde o kural yoktur; ve taze kurulum sertifikayı
      zaten aldığı için ortada geri yüklenecek bir `Caddyfile.fallback` da olmaz. Sıra şu:

      | # | Adım | Nerede | Not |
      |---|---|---|---|
      | (e0) | `RG2=libredb-mp-test2-$RANDOM` · `az group create -n "$RG2" -l westeurope` · ardından **taze bir `dnsLabelPrefix` ile** `az deployment group create -g "$RG2" …` | iş istasyonu | Bütçe sıfırlanır. `RG2`'yi burada tanımlayın — (e1) ve (e3) onu kullanıyor, ve **temizlik maddesi de silmek zorunda** |
      | (e1) | `az network nsg rule create -g "$RG2" --nsg-name libredb-studio-nsg -n DenyAcme --priority 900 --access Deny --direction Inbound --protocol Tcp --destination-port-ranges 80 --source-address-prefixes Internet` | iş istasyonu | 80 kapanır |
      | (e2) | Cert store'u silip `install.sh`'i **BİR KEZ** koşturun (yukarıdaki VM bloğu) | VM | Düşüş oluşur. ⚠️ Kısıtlı + `Internet` çift koşusunu burada **tekrarlamayın** — taze hostname'in bütçesi de 5/saat, tekrar ederseniz (e4) yine bütçe yüzünden düşer |
      | (e3) | `az network nsg rule delete -g "$RG2" --nsg-name libredb-studio-nsg -n DenyAcme` | iş istasyonu | 80 tekrar açılır |
      | (e4) | `sudo cp /opt/libredb/caddy/Caddyfile.https /opt/libredb/caddy/Caddyfile && sudo systemctl restart libredb-caddy` | VM | **Bu kez HTTPS gerçekten gelir** — kurtarma yolu kanıtlanmış olur |
- [ ] Sihirbazda HTTPS açıkken kaynak kısıtı alanının **yanında bilgi kutusu** görünüyor
      ("bu kısıt 443'e uygulanır, 80 açık kalır") — portal sandbox'ta doğrulanır
- [ ] **Her iki grubu da silin** — kurtarma testi ikinci bir grup (`RG2`) açar ve içinde çalışan bir
      VM, statik bir public IP ve bir managed disk kalır:
      `az group delete -n "$RG" --yes && az group delete -n "$RG2" --yes` → artık kaynak kalmıyor

> **Maliyet:** Standard_B2s ~$0.05/saat. Testler bittiğinde resource group'ları silin.

### 6.3 Sertifikasyon kural kontrol listesi (submit öncesi son okuma)

| Kural | Kontrol |
|---|---|
| 300.4.3 / 300.4.4 | Tüm `variables` ve `parameters` gerçekten kullanılıyor mu? (arm-ttk yakalar) |
| 300.4.4 | `location` parametresi var, varsayılanı `[resourceGroup().location]`, `allowedValues` **yok** |
| 300.4.4 | Hiçbir `securestring` parametrenin `defaultValue`'su yok |
| 300.4.5 | Hard-coded URL / endpoint yok |
| 300.4.5 | Tüm `apiVersion`'lar literal, ≤24 ay, preview değil |
| 300.4.5 | VM extension'da `autoUpgradeMinorVersion: true` |
| 300.4.5 | Sırlar `protectedSettings` içinde |
| 300.4.5 | `apiVersion`'lar ≤700 gün (kendi kapımız; politika sınırı 730). 540 günü geçenler build'de **uyarı** üretir, ≤700 kaldığı sürece hata değildir |
| **100.11 — DEĞİŞMEZ** | **`Internet`'e açık hiçbir port, hiçbir kod yolunda uygulamayı şifresiz servis etmemeli.** Bu taahhüt dört yerde yaşıyor (§5.1 tasarım tablosu · NSG kural `description`'ları · `createUiDefinition` `httpsPortNotice` · §7.8 notu) ve `install.sh`'in düşüş dalıyla sağlanıyor. **NSG veya TLS mantığına dokunan her değişiklik bu satırı yeniden doğrulamalı** — bu değişmez bir kez zaten sessizce bozuldu (P1: kısıtlı kurulumda `:80`'e düşüş) |
| 300.4.8 | İmaj referansı Marketplace imajı, `version: "latest"` |
| 300.4.8 | Diskler implicit managed disk (`storageAccountType` verildi, storage account kaynağı yok) |
| 300.4.8 | **`plan` objesi: yok — bilinçli.** Politika *"must include information about the image in the `plan` object"* der; bu yalnızca **ücretli/BYOL** Marketplace imajları içindir. `Canonical:ubuntu-24_04-lts:server` ücretsiz bir platform imajıdır, `plan` **kabul etmez** (verilirse deployment hata verir). ⚠️ Bir gün `ubuntu-pro*` gibi ücretli bir SKU'ya geçilirse `plan` bloğu **zorunlu** olur |
| F6/F7 | Template'te **hiç** `Microsoft.Resources/deployments` kaynağı yok |
| 100.3 | Logo 216–350 px kare PNG; ekran görüntüleri **tam** 1280×720 PNG |
| 100.5 | Privacy policy, dokümantasyon ve destek linkleri **çalışıyor** |

---

## 7. Faz 3 — Partner Center'da teklifin oluşturulması (alan alan)

Partner Center → **Marketplace offers** → **+ New offer** → **Azure Application**.

> **Kim:** 🧑 **Bu fazdaki her tıklama, her form alanı ve her dosya yüklemesi insan tarafından
> yapılır** — AI'ya portal oturumu verilmez (§0.1/M1). 🤖 AI'nın payı: §7.3'teki metinleri ve
> görselleri hazırlamak, karakter limitlerini ölçmek, "Notes for certification" metnini güncel
> tutmak. İnsan bunları kopyalayıp yapıştırır.
>
> ⚠️ **§7.1 ve §7.6'daki üç seçim geri alınamaz** (M5): **Offer ID**, **offer type = Azure
> Application**, **plan type = Solution template**. Bu üç ekranda ikinci bir göz bulundurun.

### 7.1 Offer setup

| Alan | Değer | Not |
|---|---|---|
| Offer ID | `libredb-studio` | **Sonradan değiştirilemez**, URL'de görünür, küçük harf |
| Offer alias | `LibreDB Studio (Azure Application)` | Sadece Partner Center içinde görünür |
| Customer leads | Önerilen: **Azure Table** veya HTTPS endpoint | Zorunlu değil ama lead toplamak isteniyorsa yayından **önce** kurulmalı; sonradan eklemek yeniden yayın gerektirir |

### 7.2 Properties

| Alan | Değer |
|---|---|
| Primary category | **Developer Tools** → subcategory: **Tools** |
| Secondary category | **Databases** → subcategories: **Relational Databases**, **NoSQL Databases** |
| Legal | **Standard Contract for Microsoft Marketplace** (önerilen — kendi şartlarını yazma yükünü ortadan kaldırır) |
| Standard contract amendments | Yok |

> ⚠️ **Geri dönüşü zor karar:** Standard Contract ile yayınladıktan sonra kendi özel şartlarınıza
> geçemezsiniz (sadece "amendment" ekleyebilirsiniz). MIT lisanslı ürün için Standard Contract
> uygundur; yine de hukuki onay alın.

### 7.3 Offer listing — birebir kullanılacak metinler

Bu metinleri `deploy/azure/listing/listing-fields.md` dosyasına da kaydedin (tek doğruluk kaynağı).

**Name** (≤200):
```
LibreDB Studio
```

**Search results summary** (limit 100 — aşağıdaki metin 88 karakter):
```
Open-source SQL IDE with AI for PostgreSQL, MySQL, MongoDB, Redis, Oracle and SQL Server
```

**Short description** (limit 256 — aşağıdaki metin 246 karakter):
```
LibreDB Studio is an open-source, self-hosted SQL IDE for cloud-native teams. Connect to PostgreSQL, MySQL, SQL Server, Oracle, SQLite, MongoDB, Redis, ClickHouse, Couchbase and Apache Druid, explore schemas, and write queries with AI assistance.
```

**Description** (HTML, limit 5000 — aşağıdaki metin **2869 karakter**; `deploy/azure/listing/description.html`):

> 🤖 Metni değiştirirseniz limiti yeniden ölçün — karakter (bayt değil) sayın:
> `python3 -c "print(len(open('deploy/azure/listing/description.html',encoding='utf-8').read()))"`.
> Partner Center HTML etiketlerini ve boşlukları da sayar (*"which includes HTML markup and spaces"*).

```html
<p><strong>LibreDB Studio</strong> is an open-source, self-hosted SQL IDE that runs entirely inside
your own Azure subscription. This solution template deploys it on a single Ubuntu 24.04 LTS virtual
machine, behind an automatically provisioned HTTPS endpoint, in about five minutes.</p>

<h3>What you get</h3>
<ul>
  <li><strong>One workspace for every engine</strong> - PostgreSQL, MySQL/MariaDB, Microsoft SQL Server
      (including Azure SQL), Oracle, SQLite, MongoDB, Redis, ClickHouse, Couchbase and Apache Druid.</li>
  <li><strong>A real editor</strong> - Monaco-based SQL editing with schema-aware autocomplete,
      formatting, query history and virtualized result grids that stay fast on large result sets.</li>
  <li><strong>AI query assistance</strong> - turn natural language into SQL, explain and optimize
      existing queries. You supply your own model provider key; no query data is sent anywhere you
      have not configured.</li>
  <li><strong>Schema and operations tooling</strong> - ERD diagrams, data profiling, EXPLAIN plans,
      slow-query and session views, and code generation.</li>
  <li><strong>Single sign-on</strong> - vendor-agnostic OIDC that works with Microsoft Entra ID,
      Okta, Auth0, Keycloak and any other compliant provider.</li>
</ul>

<h3>Why teams run it themselves</h3>
<ul>
  <li><strong>Your data never leaves your subscription.</strong> The application, its configuration
      store and every database connection stay inside your own Azure tenant.</li>
  <li><strong>No licence, no seat count, no telemetry.</strong> LibreDB Studio is MIT-licensed open
      source; this offer is free and you pay only for the Azure resources you deploy.</li>
  <li><strong>Private networking friendly.</strong> Reach databases over your virtual network, private
      endpoints or peered networks; restrict the web interface to a CIDR range at deployment time.</li>
</ul>

<h3>What this template deploys</h3>
<ul>
  <li>An Ubuntu 24.04 LTS virtual machine of the size you choose</li>
  <li>A virtual network, subnet and network security group (ports 80 and 443; SSH only if you ask for it)</li>
  <li>A static public IP address with a DNS label</li>
  <li>LibreDB Studio and a reverse proxy that obtains a free TLS certificate for that DNS name</li>
</ul>

<h3>After deployment</h3>
<p>Open the URL shown in the deployment outputs and sign in with the administrator email and password
you entered in the wizard. Application data is stored on the virtual machine's managed disk and
survives restarts.</p>

<h3>Support and source</h3>
<p>Documentation, source code and issue tracker:
<a href="https://github.com/libredb/libredb-studio">github.com/libredb/libredb-studio</a>.
Product site: <a href="https://libredb.org">libredb.org</a>.
LibreDB Studio is developed and maintained by Sekoya Grup Bilisim ve Teknoloji Ltd. Sti.</p>
```

**Search keywords** (en fazla 3):
```
SQL IDE
database client
PostgreSQL
```

**Privacy policy link:**
```
https://libredb.org/privacy-policy
```

**Useful links:**

| Ad | URL |
|---|---|
| Documentation | `https://github.com/libredb/libredb-studio#readme` |
| Deployment & configuration guide | `https://github.com/libredb/libredb-studio/blob/main/docs/DISTRIBUTION.md` |
| Release notes | `https://github.com/libredb/libredb-studio/releases` |
| Report an issue | `https://github.com/libredb/libredb-studio/issues` |
| Security policy | `https://github.com/libredb/libredb-studio/blob/main/SECURITY.md` |

**Contact information:**

| Rol | Değer |
|---|---|
| Support contact | ad + telefon + e-posta; **Support website:** `https://github.com/libredb/libredb-studio/issues` |
| Engineering contact | ad + telefon + e-posta (listede görünmez) |
| CSP Program contact | Boş bırakılabilir (CSP'ye opt-in edilmeyecekse) |

**Media:**

| Varlık | Gereksinim | Mevcut durum | Yapılacak |
|---|---|---|---|
| Large logo | 216×216 – 350×350 PNG | `public/logo.svg` — gradyanlı, glow filtreli, şeffaf zeminli | ❌ **Yeniden üret:** 300×300 PNG, **düz renk zemin**, gradyansız/glowsuz, metinsiz. Microsoft rehberi gradyan ve bulanıklığı açıkça reddediyor |
| Screenshot ×5 | **tam 1280×720** PNG + caption; Azure Application teklifinde teknik olarak **opsiyonel** ama listelemenin kalitesi için zorunlu sayın | `public/screenshots/*.png` — **1440×900 (16:10)** | ❌ **Yeniden çek/kadrala.** Ölçekleme yeterli değil, en-boy oranı farklı |
| Video | opsiyonel, YouTube/Vimeo + 1280×720 thumbnail | — | Opsiyonel |

Önerilen 5 ekran görüntüsü ve caption'ları:

1. `hero-editor` — "Write and run SQL with schema-aware autocomplete and a virtualized result grid."
2. `nl2sql` — "Turn a plain-English question into SQL with AI assistance."
3. `erd-diagram` — "Explore relationships with an automatically generated ERD."
4. `connection-modal` — "Connect to PostgreSQL, MySQL, SQL Server, Oracle, MongoDB, Redis and more."
5. `data-profiler` — "Profile table data: distributions, null ratios and outliers at a glance."

### 7.4 Preview audience

Test için kullanılacak Azure **subscription ID**'lerini girin (en az 1). Bu ID'ler müşteriye görünmez.

> ⚠️ **Preview linki bir erişim kontrolü değildir.** Microsoft'un ifadesi: *"The listing page for
> your offer preview is available to **anyone who has the preview link**."* Abonelik listesi yalnızca
> **transactable** tekliflerde satın almayı kısıtlar; bizim teklif transactable olmadığı için linki
> alan herkes listelemeyi görür. Microsoft ayrıca uyarıyor: *"Do not use the preview audience to give
> people outside your organization visibility into an offer."* Linki şirket dışına dağıtmayın.

### 7.5 Technical configuration (Azure Application seviyesinde)

Bu sayfa **yalnızca metering yapan managed application'lar için** Entra tenant/app ID ister.
Bizim solution template planımızda **doldurulacak bir şey yoktur** — boş bırakın.

### 7.6 Plan oluşturma

**Plan overview → + Create new plan**

| Alan | Değer |
|---|---|
| Plan ID | `single-vm` |
| Plan name | `Single virtual machine` |
| Plan type | **Solution template** |
| Plan summary / description | "Deploys LibreDB Studio on one Ubuntu 24.04 LTS virtual machine with automatic HTTPS. You pay only for the Azure resources." |
| Availability → Plan visibility | **Public** |
| Availability → Hide plan | **İşaretlenmeyecek** |
| Technical configuration → Version | `1.0.0` (her yayında artır) |
| Technical configuration → Package file | `libredb-studio-azure-1.0.0.zip` |

> **Yükleme sorunu yaşarsanız:** Partner Center yükleme için `https://upload.xboxlive.com`
> servisini kullanıyor; kurumsal ağ/proxy bunu engelliyorsa yükleme sessizce takılır.

> **Fiyatlandırma:** Solution template planı transact edilemediği için **yapılandırılacak bir fiyat
> alanı yoktur**; teklifin listeleme butonu otomatik olarak **Get It Now** olur ve müşteri yalnızca
> kendi Azure altyapı bedelini öder.

### 7.7 Resell through CSPs / Co-sell

- **Resell through CSPs:** İlk yayında kapalı bırakın (sonradan açılabilir).
- **Co-sell with Microsoft:** IP co-sell uygunluğu ayrı kriterler ister; ilk yayında atlayın.

### 7.8 Review and publish

- Tüm sayfaların durumu **Complete** olmalı.
- **"Notes for certification"** alanına şunu yazın (sertifikasyon ekibi bunu okuyarak test eder):

```
LibreDB Studio is an open-source (MIT) SQL IDE. Sekoya Grup Bilisim ve Teknoloji Ltd. Sti. is the
primary developer and maintainer of the software; source code is at
https://github.com/libredb/libredb-studio.

How to test this solution template:

1. Deploy the plan "Single virtual machine" into any region. Suggested values:
   - Virtual machine name: libredb-studio
   - Linux admin username: azureuser, authentication: SSH public key
   - Virtual machine size: Standard_B2s
   - DNS name label: any unique lowercase label
   - Application administrator email: admin@example.com
   - Application administrator password: any 12+ character value you choose
   - Enable HTTPS: Yes
   - Allowed source for the web interface: Internet
   - Allowed source for SSH: leave empty (inbound SSH is blocked by default)

2. Deployment usually takes about 5 minutes; allow up to 15 minutes in the worst case, because the
   installer waits for the TLS certificate before it reports success. The template output
   "applicationUrl" is the address of the application, for example
   https://<dns-label>.<region>.cloudapp.azure.com.

3. Open that URL. The Let's Encrypt certificate is already in place when the deployment reports
   success: the installer verifies it before finishing. If it cannot be issued, the installer keeps
   the deployment usable without ever widening what the customer allowed: when the interface was
   left open to the internet it falls back to plain HTTP on port 80; when the customer restricted
   the source range it stays on port 443 with a self-signed certificate, inside that range. Either
   way the reason is recorded in /etc/libredb-studio.info on the virtual machine.

4. Sign in with the administrator email and password entered in step 1.

5. The workspace ships with two built-in embedded sample connections ("Sample (LibreDB)" and
   "Sample (Employees)") so the product can be exercised end to end without an external database.
   They are editable and dismissable, not read-only.

   Open "Sample (Employees)" and run:

       SELECT * FROM employee LIMIT 10;

   The result grid appears. (Note the singular table name. The other tables in that sample are
   department, dept_emp, dept_manager, salary and title.)

   "Sample (LibreDB)" uses the embedded LibreDB engine; there the equivalent query is:

       SELECT * FROM users

Notes:
- This is a virtual-machine solution template, not a container offer. The ARM template creates no
  Microsoft.ContainerService/* or Microsoft.ContainerInstance/* resources; Docker is only an
  implementation detail of how the application process is started inside the virtual machine.
- Outbound HTTPS from the virtual machine is required. The endpoints contacted during first boot,
  and their content-delivery hosts, are:
    * the Ubuntu package archives: azure.archive.ubuntu.com and security.ubuntu.com (apt)
    * ghcr.io and pkg-containers.githubusercontent.com (the application image, pinned by digest)
    * registry-1.docker.io, auth.docker.io and the Docker Hub CDN
      (production.cloudflare.docker.com) for the Caddy reverse-proxy image, pinned by digest
    * the Let's Encrypt ACME endpoints (only when HTTPS is enabled)
    * the Azure Instance Metadata Service at 169.254.169.254 (link-local, never leaves the
      virtual network)
  No other outbound connection is made by the deployment.
- Inbound ports opened by the template, and their scopes (SSH is added only if the customer supplies
  a source CIDR; the application listens on 127.0.0.1:3000 inside the virtual machine and is never
  exposed directly):
    * HTTPS enabled: port 80 open to the internet - it carries the Let's Encrypt HTTP-01 challenge,
      needed for both issuance and renewal, plus the redirect to HTTPS; port 443 scoped to the
      "Allowed source for the web interface" value, which is where the application is served.
    * HTTPS disabled: port 80 only, scoped to that same value.
  The installer never moves the application onto a wider scope than the customer chose: see step 3.
- No credentials are hard-coded. The JWT secret is generated on the virtual machine at first boot;
  the administrator password is the value the customer entered, delivered through the CustomScript
  extension's protectedSettings.
- LibreDB Studio is MIT-licensed open source and Sekoya Grup Bilisim ve Teknoloji Ltd. Sti. is its
  primary developer and maintainer, so the offer title is the product's own name.
```

---

## 8. Faz 4 — Preview, sertifikasyon ve Go live

| Aşama | Ne olur | Süre | Kim |
|---|---|---|---|
| Automated validation | Otomatik kontroller | dakikalar | — |
| **Certification** | Manuel + otomatik teknik doğrulama: malware taraması, **network calls monitoring**, package analysis, işlevsellik testi | **SLA yok** — birkaç iş gününden birkaç haftaya | Microsoft |
| Preview creation | Preview audience'ın erişebildiği bir sürüm oluşur | dakikalar | — |
| **Publisher sign-off** | E-posta gelir, **Go live** butonu aktifleşir | — | **🧑 (M4 — sadece insan)** |
| Publish | Son doğrulamalar, teklif canlıya çıkar | ~30 dk+ | — |

**Publisher sign-off aşamasında yapılacaklar (atlamayın):**

1. Preview linkinden teklifi açın; başlık, açıklama, logo, ekran görüntüleri, linkler doğru mu?
2. Preview audience'daki abonelikle **gerçekten deploy edin** ve §6.2 kabul kriterlerini tekrar geçin.
3. Varsa tüm "Offer validation" uyarılarını çözün — Microsoft açıkça uyarıyor: uyarıları çözmeden
   **Go live** derseniz sertifikasyonda düşme riski var. (Not: bu otomatik adım dokümantasyonda
   *"For SaaS offers only"* olarak işaretli, yani Azure Application teklifinde böyle bir rapor
   **hiç gelmeyebilir** — gelmedi diye bir şeyi kaçırdığınızı düşünmeyin.)
4. **Go live**.

**Sertifikasyon başarısız olursa:** Action Center'a ve e-postaya bir "certification failure report"
düşer; ihlal edilen politika numaralarıyla birlikte. Düzeltip **istediğiniz kadar** yeniden
gönderebilirsiniz. Rapordaki politika numarasını §3'teki tabloyla eşleştirin.

---

## 9. Faz 5 — Yayın sonrası: repoya entegrasyon

Bu adımlar repo konvansiyonlarının gereğidir; **atlanırsa CI kırılır** (`distribution:matrix --check`).

> **Kim:** 🤖 tek bir PR olarak AI'ya delege edilebilir (§0.4'teki "Faz 5" istemi); 🧑 PR'ı insan
> onaylar ve merge eder.

| # | Yapılacak | Dosya | Kim |
|---|---|---|---|
| 5.1 | Kanal envanterine giriş ekle | `distribution/channels.yaml` | 🤖 |
| 5.2 | Matrisi yeniden üret | `bun run distribution:matrix` (`docs/CHANNELS.md` otomatik güncellenir) | 🤖 |
| 5.3 | `docs/CHANNELS.md` sonundaki "Planned and deliberately not counted here" satırından **Azure'u çıkar** | `docs/CHANNELS.md` | 🤖 |
| 5.4 | README'nin install/deploy bölümüne Azure Marketplace linkini ekle | `README.md` | 🤖 |
| 5.5 | `deploy/azure/README.md` yaz (build + submit + update runbook özeti) | — | 🤖 |
| 5.6 | Takip issue'sunu kapat / güncelle | GitHub | 🧑 |

`distribution/channels.yaml` için hazır giriş (DigitalOcean girişiyle aynı şablon):

```yaml
  - id: azure-marketplace
    name: Microsoft Azure Marketplace (Azure Application, solution template)
    short_name: Azure Marketplace
    # Faz 5 Go-live'dan SONRA çalışır, dolayısıyla doğru değer "live"dır.
    # (Teklifi Partner Center'da oluşturup henüz yayınlamadıysanız "pending" yazın
    #  ve Go-live'da "live"a çevirmeyi unutmayın — aksi halde docs/CHANNELS.md
    #  yanlış durum yayınlar ve kimse geri dönüp düzeltmez.)
    status: live
    category: cloud-marketplaces
    platforms: [cloud]
    tier: 4
    kind: marketplace
    update:
      method: manual_ui
      sla: on_demand
    links:
      tracking_issue: https://github.com/libredb/libredb-studio/issues/<NUMARA>
      first_pr: https://github.com/libredb/libredb-studio/pull/<NUMARA>   # karşılaştırılabilir her kanal bunu taşıyor
      # Teklifin gerçek URL'ini Partner Center'dan kopyalayın (yeni mağaza biçimi;
      # eski azuremarketplace.microsoft.com adresleri hâlâ yönlendiriyor).
      catalog: https://marketplace.microsoft.com/en-us/product/<...>/<publisherId>.libredb-studio
      docs: deploy/azure/AZURE_MARKETPLACE_PLAN.md
    pin:
      strategy: none
```

> `pin.strategy: none` bilinçli: Marketplace paketinin sürümünü uzaktan sorgulayan bir probe yok.
> Bunun bedeli, paketin uygulama sürümünün gerisinde kalmasının otomatik yakalanmamasıdır —
> §10'daki runbook'u release checklist'ine ekleyin.

---

## 10. Sürüm güncelleme runbook'u

LibreDB Studio her sürümde Marketplace paketini **otomatik güncellemez**. Yeni bir uygulama sürümünü
Marketplace'e taşımak için:

| # | Adım | Kim |
|---|---|---|
| 1 | Yeni sürümün GHCR'da yayınlandığını doğrula: `ghcr.io/libredb/libredb-studio:<yeni sürüm>` | 🤖 |
| 2 | `Azure Marketplace Package` workflow'unu çalıştır (`version` = yeni uygulama sürümü, `packageVersion` = son yayınlanan paket sürümünün bir üstü, ör. `1.0.0` → `1.0.1`) | 🤖 |
| 3 | arm-ttk yeşil mi? Değilse önce onu düzelt | 🤖 |
| 4 | Yeni zip'i **kendi aboneliğinde deploy et** ve §6.2 kabul kriterlerini geçir | 🧑🤖 |
| 5 | Değişen bir şey varsa listeleme metinlerini güncelle (ör. yeni desteklenen veritabanı) | 🤖 hazırlar |
| 6 | Partner Center → teklif → plan → **Technical configuration**: Version'ı artır, yeni zip'i yükle | 🧑 |
| 7 | **Review and publish** → sertifikasyon → **Go live** | 🧑 |

**Ne sıklıkta?** Her yamada değil; anlamlı sürümlerde (yeni provider, güvenlik düzeltmesi, büyük
özellik). Öneri: **her minor sürümde + her güvenlik yamasında**. Bu kararı
`distribution/channels.yaml`'daki `update.sla: on_demand` ile tutarlı tutun.

> ⚠️ **Sadece Technical configuration sayfasını değiştirseniz bile teklif tekrar sertifikasyondan
> geçer.** Yayındaki teklif, siz **Go live** demeden güncellenmez; müşteriler bu sürede eski paketi
> almaya devam eder (kesinti olmaz).

---

## 11. Riskler, ret sebepleri ve azaltımlar

| # | Risk | Olasılık | Etki | Azaltım |
|---|---|---|---|---|
| R1 | Partner Center **işletme/istihdam doğrulaması** uzuyor veya reddediliyor (SUSE başvurusunda bu tam olarak başımıza geldi: "Unable to verify address from website") | Orta | Yüksek — her şey bloke | Şirket adı/adresi resmî kayıtla birebir aynı yazılmalı; domain registrar belgesi hazır bulundurulmalı. **Adres yayını tarafı hazır ✅** — `libredb.org/privacy-policy` tam tescilli adresi taşıyor (Inkilap Mah. … Umraniye/Istanbul). Kalan iş yalnızca aynı bilginin `sekoya.tech` üzerinde de görünür olması |
| R2a | Sertifikasyon, VM'in **dışarıdan konteyner imajı indirmesini** sorun etsin | Düşük–Orta | Orta | "Notes for certification"da tüm çıkış uçları tek tek beyan edildi; imajlar **digest ile pinli**; alternatif plan: Faz 7 (VHD tabanlı VM offer) |
| R2b | Teklif, **"container tabanlı çözüm"** sayılıp solution template kapsamı dışına itilsin (bkz. §2'deki alıntı) | Düşük | **Yüksek** — teklif tipi değişmek zorunda kalır | Hazır cevap: ARM template hiçbir `Microsoft.ContainerService/*` / `Microsoft.ContainerInstance/*` kaynağı oluşturmuyor, Docker VM içi bir uygulama detayı. Bu cümle "Notes for certification"a **önden** yazıldı. Ret gelirse: Faz 7 (VHD) devreye alınır ve Docker imaj içine pişirilir |
| R3 | **arm-ttk** hataları sertifikasyonu düşürsün | Orta | Düşük (düzeltilebilir) | CI'da zorunlu kapı (§5.7); submit öncesi sıfır kırmızı kuralı |
| R4 | Let's Encrypt sertifikası alınamıyor (ACME rate limit, geçici LE arızası, müşterinin araya soktuğu güvenlik duvarı) → **Caddy adlandırılmış siteyi `:443`'te sunup `:80`'i oraya yönlendirdiği için uygulama HER İKİ portta erişilemez hale gelir** | **Düşük–Orta** (açık `issuer acme` bloğu yedek CA'yı düşürdüğü için ilk iki sebebe karşı yedeklilik yok — bkz. §5.1'deki "tek CA" satırı) | Orta | Üç katmanlı savunma: (1) **kök sebep kaldırıldı** — HTTPS açıkken NSG'de 80 her zaman `Internet`'e açık kalır (ACME HTTP-01 yalnızca 80'e ihtiyaç duyar), müşterinin kaynak kısıtı 443'e uygulanır; (2) kurulum sonunda `curl --resolve <fqdn>:443:127.0.0.1` ile **gerçek sertifika doğrulanır**; (3) doğrulama 3 dakikada geçmezse Caddyfile `Caddyfile.https` olarak yedeklenir ve **kısıt durumuna göre dallanan** düşüş devreye girer (kısıtsız → `:80` düz HTTP; kısıtlı → `:443` self-signed), `/etc/libredb-studio.info` + MOTD bunu **açıkça** yazar. `enableHttps=false` zaten ayrı bir kaçış yolu |
| R5 | Logo/ekran görüntüsü boyut ve stil kurallarına takılma | **Yüksek** (mevcut varlıklar uygun değil) | Düşük | §7.3'teki "yapılacak"lar; 1280×720 ve düz-renk logo üretimi Faz 1 içinde tamamlanmalı |
| R6 | Docker Hub anonim çekme limiti nedeniyle Caddy imajı çekilemez (uygulama imajı GHCR'da olduğu için etkilenmez) | Düşük | Orta | Caddy imajını **digest ile pinle**; kalıcı çözüm: **Caddy imajını GHCR'a mirror'la** (`ghcr.io/libredb/caddy`) — böylece VM'in tek dış bağımlılığı GHCR olur |
| R7 | "Terms of use" linki eksik (libredb.org'da terms sayfası yok) | Orta | Düşük | **Standard Contract** kullan (§7.2) veya `libredb.org/terms` yayınla |
| R8 | Teklif tipi yanlış seçilir ve **geri alınamaz** | Düşük | Yüksek | Offer type = **Azure Application**, plan type = **Solution template**. Bu iki seçim ekranında ikinci bir göz olsun |
| R9 | Offer ID sonradan değiştirilemez | Düşük | Orta | `libredb-studio` — tek seferde doğru gir |
| R10 | Paket sürümü geriye gider / aynı kalır → yükleme reddedilir | Orta | Düşük | `deploy/azure/package-version.txt` tek doğruluk kaynağı; workflow input'u zorunlu |
| R11 | 100.1.1 (açık kaynak yeniden paketleme) itirazı | Düşük | Düşük | Biz asıl geliştiriciyiz; "Notes for certification"da ve açıklamada belirtildi |
| R12 | Marketplace paketi uygulama sürümünün gerisinde kalır ve kimse fark etmez | **Yüksek** | Düşük–Orta | §10 runbook'u release checklist'ine ekle; 6 ayda bir manuel denetim |

---

## 12. Doğrulanması zorunlu varsayımlar

Bu dokümandaki her şey Microsoft'un **2026-08-05 tarihli** dokümantasyonuna dayanır.

Bu liste 2026-08-05'te bağımsız bir denetimden geçti (`REVIEW.md`); **kapananlar aşağıda ✅ ile
işaretli, kalanlar hâlâ açık.**

### Açık — uygulamadan önce mutlaka kontrol edin

1. 🔴 **`apiVersion` yaşı.** Değerler `2025-07-01` (Network) / `2026-03-01` (Compute) olarak
   güncellendi, ama bu **kalıcı bir çözüm değil**: 730 günlük pencere kayar. Her paket üretiminde
   `build-azure-package.mjs`'nin 540 günlük yaş kapısı (§5.6, adım 6) çalışmalı. İlk taslakta bu
   hata gerçekleşti — değerler yazıldıkları gün bile 826 günlüktü.
2. **Ubuntu URN'i.** `Canonical:ubuntu-24_04-lts:server:latest` doğrulandı; yine de
   `az vm image list -p Canonical --all -o table | grep 24_04` ile teyit edin. 26.04 LTS çıktıysa
   geçiş kararını bilinçli verin (LTS non-Pro imajlar ücretsizdir; **Pro imajlar ücretlidir**,
   ayrıca `plan` bloğu zorunlu olur — yanlışlıkla Pro SKU seçmeyin).
3. **Partner Center ekran/alan adları.** Microsoft UI'ı sık değiştiriyor; "Technical configuration",
   "Plan overview" gibi sekme adları farklı görünebilir. Akış aynı kalır.
4. **createUiDefinition regex'leri ve `visible` ifadeleri** (`sshWarning`, `httpsPortNotice`) —
   portal sandbox'ında (§6.1, kontrol 2.3) doğrulanmadan hiçbir şey kabul edilmemeli. Şemalar
   denetimde geçerli bulundu, ama `visible` mantığının gerçek davranışı yalnızca sandbox'ta görünür.
5. **Caddy imaj etiketi** — `caddy:2.10-alpine` yerine build anındaki güncel stabil sürümü digest
   ile pinleyin.
6. **TLS düşüş yolunun her iki dalı (§5.3).** `curl --resolve` doğrulaması, kısıtsız kurulumda
   `:80`'e düşüş ve **kısıtlı kurulumda `:443` + self-signed'da kalma** gerçek bir deployment'ta
   test edilmeli (§6.2'deki iki maddeli "TLS düşüş senaryosu"). Bu, planın taşıyıcı güvenlik
   değişmezini (§6.3, 100.11) doğrulayan tek testtir.
7. **Caddy'nin challenge seçimi.** `disable_tlsalpn_challenge` ucuz bir sigorta olarak eklendi,
   ancak Caddy'nin direktifsiz halde önce hangi challenge'ı denediği buradan kesin doğrulanamadı.
   İlk gerçek deployment'ta `docker logs libredb-caddy` çıktısında bir TLS-ALPN denemesi görünüyor
   mu, bakın; ayrıca üretilen Caddyfile'ı `caddy validate` ile doğrulayın (§6.1, kontrol 2.9).
8. **Pinlenmiş Caddy sürümünde ZeroSSL, EAB olmadan kullanılabilir mi?**
   ✅ *Kapandı olan kısım:* Caddy'nin varsayılan issuer kümesinin bir **çift** olduğu artık
   dokümante bir gerçek — `acme_ca` global option'ının tanımı: *"Default: **ZeroSSL and Let's
   Encrypt's production endpoints**."* Yani açık `issuer acme` bloğumuz gerçekten ikinci CA'yı
   düşürüyor ve §5.1'deki "tek CA — bilinçli bedel" satırı ile R4'ün Düşük–Orta olasılığı
   doğrulanmış bir temele oturuyor.
   ❓ *Açık kalan kısım:* yalnızca **yedekliliği geri getirmeye karar verilirse** önemli — ZeroSSL
   pinlediğiniz sürümde EAB kimlik bilgisi olmadan kullanılabiliyor mu? `caddy adapt` çıktısıyla
   ölçün (§6.1, kontrol 2.9).

### Denetimde kapandı

| Eski varsayım | Sonuç |
|---|---|
| `base64(parameters('appAdminPassword'))` ARM'da kabul edilir mi? | ✅ **Kısıt yok.** Secure parametreler için yazılı tek kısıt "deployment history'ye yazılmaz"dır; ifadelerde kullanımı yasaklanmamış. Resmî quickstart'lar `protectedSettings` içinde secure parametreyi `concat()` ile kullanıyor. Yine de ilk deployment bunu fiilen kanıtlayacak |
| `Test-AzMarketplacePackage` çıktısında `$_.Errors` doğru alan mı? | ✅ **Doğru** — Microsoft'un kendi pipeline örneği aynı filtreyi kullanıyor |
| arm-ttk release asset adı `arm-ttk.zip` mi? | ✅ **Doğru** (son release: tag `20260213`, tek asset `arm-ttk.zip`; içindeki yol `arm-ttk/arm-ttk/arm-ttk.psd1`) |
| createUiDefinition çıktıları ↔ template parametreleri eşleşiyor mu? | ✅ **14 output ↔ 14 parametre**, isim ve tip birebir doğrulandı (`sshWarning` ve `httpsPortNotice` birer InfoBox'tır, çıktı üretmezler) |
| Marketplace Ingestion MCP server Azure Application'ı destekliyor mu? | ✅ **Desteklemiyor** — teyit edildi. Otomasyon isteniyorsa Partner Center submission API (`https://api.partner.microsoft.com`, Entra app + client credentials) araştırılmalı; ilk yayını yine de **elle** yapın |

---

## 13. Opsiyonel Faz 6 — Azure Container (Kubernetes app) teklifi

Solution template canlıya çıktıktan **sonra** değerlendirin. AKS kullanan kurumsal müşterilere
ulaşmanın yolu budur ve **mevcut Helm chart'ımızı** kullanır.

**Ne gerekiyor:**

| # | Gereklilik | Bizdeki durum |
|---|---|---|
| 1 | Uygulama **Helm chart tabanlı** olmalı | ✅ `charts/libredb-studio` |
| 2 | Chart'ta `.tgz` arşiv olmamalı, her şey açık dosya | ⚠️ `postgresql` subchart bağımlılığı var → Marketplace paketinde **`postgresql.enabled=false`** ile çıkarılmalı (Bitnami bağımlılığı ayrıca ayrı bir tedarik riski) |
| 3 | **Tüm imaj referansları `values.yaml`'da `global.azure.images.*` altında parametrelenmeli** | ❌ Yapılacak iş: chart template'lerinde imaj referansları bu şemaya taşınmalı |
| 4 | Çalışma zamanında hiçbir imaj/chart indirilmemeli | ✅ (postgresql çıkarıldıktan sonra) |
| 5 | **Linux/AMD64** imaj | ✅ (arm64 manifesti de var; Marketplace amd64 kullanır) |
| 6 | İmajlar **zafiyetsiz** olmalı; Microsoft düzenli tarar ve bulursa teklifi gizleyebilir | ⚠️ Sürekli yük: Trivy/Defender taraması CI'a eklenmeli |
| 7 | Publishing tenant'a bağlı bir **Azure Container Registry** | ❌ Kurulacak |
| 8 | `Microsoft.PartnerCenterIngestion` resource provider kaydı + `32597670-3e15-4def-8851-614ff48c1efa` service principal'a `acrpull` rolü | ❌ Yapılacak |
| 9 | **CNAB paketi**: `manifest.yaml` + Helm chart dizini + `mainTemplate.json` + `createUiDefinition.json`, `mcr.microsoft.com/container-package-app` ile `cpa verify` / `cpa buildbundle` | ❌ Yapılacak |
| 10 | Fiyatlandırma | ✅ **Free** lisans modeli mevcut (plan tipini seçtikten sonra "Pricing model" kolonunda "Free" görünür, orada seçilebilir bir alan değildir) |
| 11 | Açıklamaya `KubernetesApps` terimi eklenmeli (keşfedilebilirlik kuralı 400.2) | ❌ |

**Önemli uyarı:** CNAB'daki imajlar Microsoft'un **herkese açık** ACR'ına kopyalanır
(*"Container images in the Microsoft-owned public ACR are accessible to anyone"*). Bizim imajımız
zaten public olduğu için bu bir sorun değil.

Başlangıç noktası: <https://github.com/Azure-Samples/kubernetes-offer-samples>

---

## 14. Opsiyonel Faz 7 — Azure Virtual Machine teklifi

**R2a veya R2b gerçekleşirse** plan B olarak devreye alın. İki tetikleyicinin gereksinimi farklıdır:

- **R2a** (Microsoft, deploy anında dışarıdan imaj indirilmesini kabul etmezse): imaj VHD'ye
  önceden çekilir, müşteri boot'unda registry erişimi gerekmez.
- **R2b** (teklif "container tabanlı çözüm" sayılırsa): Docker'ın kendisi de **imaj build anına**
  taşınır — yani konteyner çalıştırma detayı deploy anından çıkar, VHD içinde pişmiş bir servis
  olarak gelir. DigitalOcean hattımız zaten tam olarak bunu yapıyor.

Gerekenler: hazır bir **VHD** (Ubuntu tabanlı, waagent yapılandırılmış, sysprep/deprovision edilmiş),
Shared Image Gallery veya SAS URL üzerinden paylaşım, VM imaj sertifikasyon testleri, ve **BYOL /
free** lisans modeli. DigitalOcean için zaten Packer tabanlı bir imaj üretim hattımız var
(`deploy/digitalocean/droplet/template.pkr.hcl`) — Packer'ın `azure-arm` builder'ı ile aynı desen
Azure'a taşınabilir; `01-install.sh` / `02-configure.sh` mantığı büyük ölçüde yeniden kullanılabilir.

Bu yol **daha fazla bakım yükü** getirir (her sürümde yeni VHD + yeni sertifikasyon), o yüzden
varsayılan tercih değildir.

---

## 15. Ekler

### 15.1 Görev dağılımı

Tek doğruluk kaynağı **[§0 — Görev dağılımı](#0-görev-dağılımı--kim-neyi-yapar)**'dır; burada
tekrarlanmaz (iki listenin zamanla birbirinden ayrılmaması için).

### 15.2 Linkler

**Portallar**
- Partner Center: <https://partner.microsoft.com/dashboard/home>
- Marketplace teklifleri: <https://partner.microsoft.com/dashboard/commercial-marketplace/overview>
- Mağaza (müşteri görünümü): <https://marketplace.microsoft.com>
- createUiDefinition sandbox: <https://portal.azure.com/#view/Microsoft_Azure_CreateUIDef/SandboxBlade>

**Dokümantasyon**
- Teklif tipleri: <https://learn.microsoft.com/en-us/partner-center/marketplace-offers/publisher-guide-by-offer-type>
- Azure Application planlama: <https://learn.microsoft.com/en-us/partner-center/marketplace-offers/plan-azure-application-offer>
- Solution template gereksinimleri: <https://learn.microsoft.com/en-us/partner-center/marketplace-offers/plan-azure-app-solution-template>
- Solution template plan yapılandırma: <https://learn.microsoft.com/en-us/partner-center/marketplace-offers/azure-app-solution>
- Listeleme seçenekleri: <https://learn.microsoft.com/en-us/partner-center/marketplace-offers/determine-your-listing-type>
- Sertifikasyon politikaları: <https://learn.microsoft.com/en-us/legal/marketplace/certification-policies>
- ARM template test toolkit: <https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/test-toolkit>
- arm-ttk sürümleri: <https://github.com/Azure/arm-ttk/releases>
- createUiDefinition referansı: <https://learn.microsoft.com/en-us/azure/azure-resource-manager/managed-applications/create-uidefinition-overview>
- Customer usage attribution: <https://learn.microsoft.com/en-us/partner-center/marketplace-offers/azure-partner-customer-usage-attribution>
- Yayın akışı: <https://learn.microsoft.com/en-us/partner-center/marketplace-offers/review-publish-offer>
- Hesap doğrulaması: <https://learn.microsoft.com/en-us/partner-center/enroll/understand-the-verification-process>
- Kategoriler: <https://learn.microsoft.com/en-us/partner-center/marketplace-offers/marketplace-categories-industries>
- Mastering the Marketplace (video/lab): <https://microsoft.github.io/Mastering-the-Marketplace/>
- Kubernetes offer örnekleri: <https://github.com/Azure-Samples/kubernetes-offer-samples>

**Repo içi ilgili dosyalar**
- `docs/DISTRIBUTION.md` — kanal kurulum/işletim rehberi, zero-config ve strict mod
- `docs/CHANNELS.md` + `distribution/channels.yaml` — kanal envanteri (Faz 5'te güncellenir)
- `deploy/digitalocean/` — aynı ürünün başka bir bulut pazarındaki kanıtlanmış deseni
- `charts/libredb-studio/` — Faz 6'nın temeli
- `Dockerfile` — `ghcr.io/libredb/libredb-studio` imajının kaynağı

### 15.3 Terimler

| Terim | Anlamı |
|---|---|
| **ARM template** | Azure Resource Manager şablonu; deploy edilecek kaynakları tanımlayan JSON |
| **createUiDefinition** | Azure portalındaki kurulum sihirbazının ekranlarını tanımlayan JSON |
| **Solution template** | Müşterinin kendi aboneliğine kaynak deploy eden, Marketplace üzerinden para akışı olmayan plan tipi |
| **Transactable** | Ödemenin Microsoft üzerinden aktığı teklif; bizde yok |
| **arm-ttk** | ARM template test toolkit; Marketplace kurallarını kontrol eden PowerShell test seti |
| **Customer usage attribution** | Deploy edilen Azure kaynaklarının hangi partner yazılımı için oluştuğunu Microsoft'un iç sistemlerinde ilişkilendiren izleme kimliği |
| **CNAB** | Cloud Native Application Bundle; Kubernetes teklifleri için paketleme formatı |
| **Preview audience** | Teklif canlıya çıkmadan önce erişebilen Azure abonelik ID'leri listesi |
| **Go live** | Yayıncının teklifi herkese açık hale getirdiği son onay adımı |

---

## Değişiklik geçmişi

| Tarih | Değişiklik |
|---|---|
| 2026-08-05 | İlk sürüm. Microsoft Learn dokümantasyonu bu tarihte doğrulandı. |
| 2026-08-05 | **1. denetim turu** (`REVIEW.md` §1–6): 5 bloke edici + 6 orta + 9 düşük bulgu düzeltildi. `apiVersion`'lar `2025-07-01` / `2026-03-01`'e taşındı (eskisi yazıldığı gün 826 günlüktü); sertifikasyon test sorgusu `employee` olarak düzeltildi; "read-only" beyanı kaldırıldı; TLS doğrulama + düz HTTP'ye düşüş yolu eklendi; health payload `"healthy"` oldu; apt kilidi, script testi, `plan` objesi kaydı, kanal durumu düzeltildi. |
| 2026-08-05 | **2. denetim turu** (`REVIEW.md` §8): 12 bulgu. NSG kuralları ikiye ayrıldı — 80 ACME için `Internet`'te, 443 müşterinin kaynak aralığında; böylece "arayüzü CIDR'a kısıtla" yeteneği geri geldi ve listeleme metniyle çelişki bitti. Çıkış uçları beyanı CDN hostlarıyla tamamlandı; süre beyanları (~15 dk tavan) düzeltildi; TLS düşüş testi uygulanabilir hale getirildi; `apiVersion` yaş kapısına `$schema` istisnası ve kapı tarihleri eklendi; Caddyfile yedeği (`Caddyfile.https`); `cloud-init status --wait`; `notes` çıktısı; §14 iki tetikleyiciye ayrıldı. |
| 2026-08-05 | **3. denetim turu** (`REVIEW.md` §10): 7 bulgu. **P1 bir güvenlik regresyonuydu** — kısıtlı bir kurulumda TLS düşüşü uygulamayı `Internet`'e açık 80 portuna taşıyıp müşterinin kısıtını sessizce baypas ediyordu; düşüş artık dallanıyor (`Internet` → `:80`, kısıtlı → `:443` + self-signed) ve §6.3'e taşıyıcı bir 100.11 değişmezi eklendi. ACME issuer'ında `disable_tlsalpn_challenge`; yaş kapısı iki eşikli oldu (540 uyarı / 700 hata); `metadata.description`, mimari diyagramı, düşüş yorumu ve simülasyon komutu tazelendi. |
| 2026-08-05 | **4. denetim turu** (`REVIEW.md` §12): 6 bulgu, hiçbiri bloke edici değil. §5.6'daki bayat tek-eşik gerekçesi silindi; açık `issuer acme` bloğunun yedek CA'yı düşürdüğü tespit edilip **tek CA kararı bilinçli olarak §5.1'e yazıldı** ve R4'ün olasılığı Düşük → Düşük–Orta'ya çekildi; simülasyondaki `hostname -f` (Azure'da iç ad döndürür, testi yanlış sebeple geçirirdi) `az network public-ip show` ile değiştirildi; `0.0.0.0/0` kenar durumu; geri-yükleme talimatı çift yönlü yapıldı (`Caddyfile.fallback`). |
| 2026-08-05 | **5. denetim turu** (`REVIEW.md` §14): 5 bulgu, üçü **kurtarma yolunda** toplandı — planın hiç yürünmemiş tek yüzeyi orası. Geri-yükleme talimatı, her koşulda geçen bir erişilebilirlik kontrolü yerine **gerçek teşhise** (Caddy ACME log'u) dayanıyor ve "rate limit ölçülemez, beklenir" ayrımını yapıyor; `Caddyfile.fallback` yedeğini artık **kurulum** yazıyor (operatörün ikinci denemede kaçış kapısını yok etmesi mümkün değil); §6.2 simülasyonu iş istasyonu / VM olarak ayrıldı ve `https\?` deseni `https`e sabitlendi; §6.2'ye kurtarma yolunun kendi testi eklendi; §5.1 çapraz referansı ve bu tablonun sırası düzeltildi. |
| 2026-08-05 | **6. denetim turu** (`REVIEW.md` §16): 3 bulgu, **üçü de §6.2'deki test prosedüründe** — ürün tarafında bulgu yok. Kurtarma testi kendi eliyle Let's Encrypt'in saatlik başarısız-doğrulama bütçesini tüketip son adımını yanlış sebeple düşürüyordu; (e) adımı artık **taze bir hostname** üzerinde koşuyor (staging alternatifiyle birlikte). Kurtarma adımları makine etiketli bir tabloya çevrildi ve eksik `nsg rule delete` komutu yazıldı; (c)'nin beklentisi `:80`'in 308 yanıt verdiğini yansıtacak şekilde kesinleştirildi. Simülasyondaki `FQDN` okumasına, boş kalırsa testi sessizce geçirmek yerine durduran bir koruma eklendi. |
| 2026-08-05 | **7. denetim turu** (`REVIEW.md` §18): 3 bulgu, üçü de bir önceki turun düzeltmesinin içinde. (e) adımı yazıldığı şekliyle uygulanamıyordu (taze deployment'ta `DenyAcme` yok, geri yüklenecek `Caddyfile.fallback` yok) → **e0–e4** olarak düşüşü yeniden üreten bir sıraya çevrildi ve bütçeyi asıl kimin tükettiği düzeltildi. Staging alternatifi global `acme_ca` ile **sessizce üretime giderdi** → dizin `issuer acme { dir … }` bloğunun içine alındı. VM bloğu `sudo bash <<'VMBLOCK'` ile sarıldı (çıplak `exit 1` SSH oturumunu kapatıyordu). Ayrıca **§12 madde 8 daraldı**: Caddy'nin varsayılan issuer çifti (ZeroSSL + LE) artık dokümante bir gerçek, "tek CA" kararı doğrulanmış temele oturdu. |
| 2026-08-05 | **8. denetim turu** (`REVIEW.md` §20): 3 bulgu, hepsi 🟡 ve üçü de bir önceki turun mekanik artığı — sekiz turda ilk kez **tek bir orta şiddetli bulgu bile yok**. `RG2` (e0)'da tanımlandı ve temizlik maddesi **her iki grubu** silecek şekilde düzeltildi (aksi halde unutulan bir test VM'i fatura üretiyordu); girintili heredoc'un ham dosyadan kopyalanınca sonlanmayacağı uyarısı eklendi; ikinci koşu için `FQDN_OVERRIDE` kancası kondu. **Statik denetim burada kapandı** — bundan sonrasının girdisi doküman değil, `arm-ttk` / portal sandbox / ilk deployment çıktılarıdır. |
