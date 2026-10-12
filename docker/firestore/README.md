# Firestore emulator fixture

The `firestore` service of `database-compose.yml` runs the Firestore emulator of Cloud SDK 587.0.0 (`cloud-firestore-emulator` 1.22.0) from the official emulators image, pinned by digest.
It speaks plain HTTP, keeps everything in memory and accepts any project id; removing the container resets it.

    docker compose -f database-compose.yml up -d firestore firestore-seed

`firestore-seed` writes `seed.json` into the project `demo-libredb` with one `:commit` request and exits.
Start Studio with `FIRESTORE_EMULATOR_HOST=127.0.0.1:8380` on the host, or `FIRESTORE_EMULATOR_HOST=firestore:8080` inside the compose network, and connect with the project id `demo-libredb` and an empty credential ([providers/firestore.md](../../docs/providers/firestore.md)).

## The data

| Collection | Documents | What it shows |
| --- | --- | --- |
| `users` | `alice`, `bob`, `carol`, `a:b` | `alice` holds every value type, a vector and a field named `dotted.key`; `age` is an integer in two documents and a string in one; `a:b` is an id with a colon, with a subcollection `notes` |
| `users/alice/orders` | `o1`, `o2` | a subcollection, also reached by `db.collectionGroup("orders")` |
| `orders` | `0001` to `0005` | an odd document count, for the Keys panel at a small page count |
| `orphans` | none present; `ghost` exists only through `orphans/ghost/notes/n1` | a missing parent |
| `products` | `p1`, `p2`, `p3` | three-dimension vectors in `embedding`, for `findNearest` |
| `ids` | `z`, `Ａ` (U+FF21), `𐐀` (U+10400) | ids whose UTF-16 and UTF-8 orders differ |
| `Ａ-col`, `𐐀-col` | `d1` each | top-level collection ids whose UTF-16 and UTF-8 orders differ |

`seed.json` is also the seed `tests/live/firestore-evidence.ts` writes into the pinned emulator jar before each capture scenario, so the fixture and the captures hold the same data.
