# Customer Service Integration Platform

ต้นแบบสำหรับ Technical Assessment ของ Partilon: ระบบ Customer และ Order แบบแยกบริการ พร้อม Kong Gateway และ Agent ที่ประสานงานผ่าน A2A

## สถาปัตยกรรม

```mermaid
flowchart LR
  Client[Client] -->|HTTP + client API key| Kong[Kong DB-less Gateway]
  Kong -->|POST /api/v1/agent/query| Plan
  subgraph Coordinator[Coordinator / Express]
    Plan[Plan: intent, IDs, capabilities] --> Discover[Discover: match Agent Card skills]
    Discover --> Execute[Execute: run A2A tasks in order]
    Execute --> Respond[Respond: answer + plan trace]
  end
  Discover -->|Agent Card request| Kong
  Execute -->|A2A task + coordinator key| Kong
  Respond -->|HTTP JSON: ok or partial| Kong
  Kong -->|Agent Card / task route| CustomerAgent[Customer Agent / A2A SDK]
  Kong -->|Agent Card / task route| OrderAgent[Order Agent / A2A SDK]
  CustomerAgent -->|Managed REST API + service key| Kong
  OrderAgent -->|Managed REST API + service key| Kong
  Kong --> CustomerAPI[Customer API / Express]
  Kong --> OrderAPI[Order API / Express]
  CustomerAPI --> CustomerDB[(customer_db)]
  OrderAPI --> OrderDB[(order_db)]
  Kong -->|HTTP response| Client
```

บริการทั้งหมดเป็น Express + TypeScript; Customer API และ Order API เป็นเจ้าของ PostgreSQL คนละ database และคนละ role แม้ใช้ PostgreSQL container เดียว Agent ไม่มีสิทธิ์ต่อฐานข้อมูลโดยตรง

## เริ่มใช้งาน

ต้องมี Docker Desktop ที่เปิดใช้งาน Docker Compose ได้ และพอร์ต `8000` ว่าง คัดลอก `.env.example` เป็น `.env` เพื่อกำหนด port, timeout, log level และ PostgreSQL superuser password สำหรับการเริ่มฐานข้อมูลครั้งแรก; ถ้าไม่สร้าง `.env` Compose จะใช้ค่าเริ่มต้นเดียวกัน

```powershell
Copy-Item .env.example .env
docker compose up --build -d
docker compose ps
```

`.env.example` ตั้งค่า host ports, Coordinator timeout, application log level และ PostgreSQL superuser password; demo API keys กับ application database role passwords ยังคงกำหนดไว้ใน `kong/kong.yml` และ `db/init.sql` สำหรับ assessment นี้

รอจน services แสดงสถานะ `healthy` แล้วเรียก API ผ่าน `http://localhost:8000` โดยใช้ demo key `demo-client-key` ใน header `apikey`:

```powershell
curl.exe -H "apikey: demo-client-key" http://localhost:8000/api/v1/customers/C001
curl.exe -H "apikey: demo-client-key" http://localhost:8000/api/v1/orders/O1001
curl.exe -H "apikey: demo-client-key" "http://localhost:8000/api/v1/orders?customerId=C001&limit=1"
curl.exe -X POST http://localhost:8000/api/v1/agent/query -H "apikey: demo-client-key" -H "Content-Type: application/json" -d '{"query":"Find customer C001 and tell me their latest order status"}'
curl.exe -X POST http://localhost:8000/api/v1/agent/query -H "apikey: demo-client-key" -H "Content-Type: application/json" -d '{"query":"Show all orders for C001"}'
```

## ดู access logs และตาม request

Kong ส่ง access logs ไปที่ stdout โดยแต่ละบรรทัดมีเวลา, method, URI, HTTP status, เวลา request, upstream และ `X-Correlation-ID`; ดู logs ได้จาก terminal ด้วย Docker Compose:

```powershell
docker compose logs -f kong coordinator customer-agent order-agent customer-api order-api
```

Coordinator และ services ใช้ Pino เขียน structured logs เพิ่มรายละเอียดแผน, capability/Agent ที่เลือก และผลของแต่ละขั้นไว้ด้วย correlation ID เดียวกัน หากต้องการกรอง request ที่กำหนดเอง:

```powershell
docker compose logs --since 10m kong coordinator customer-agent order-agent customer-api order-api | Select-String "trace-demo-002"
```

Stack นี้ปิด Kong Admin API และไม่มีหน้า dashboard สำหรับ access logs; ใช้ `docker compose logs` ดู stdout ของ Kong และ services ได้เลย

การค้น `C999` ผ่าน Customer API หรือ Agent API คืน `404` พร้อมข้อความ `not_found`; ส่วนคำขอรวม customer กับ order จะทำงานตามลำดับ และแสดงผลบางส่วนอย่างชัดเจนหากไม่พบ order

## Agent ทำงานอย่างไร

- Coordinator แยกการทำงานเป็น Plan → Execute → Respond: สร้างแผนจาก query, เลือก capability จาก Agent Card ที่ค้นพบผ่าน Kong, ทำงานตามลำดับ และสรุปเฉพาะข้อมูลที่ดึงได้จริง
- ก่อนเรียก Agent ระบบ log แผนและ capability ที่จะใช้; response มี `meta.plan.steps` แสดง Agent ที่เลือกและผลของแต่ละขั้น เพื่อไล่การตัดสินใจด้วย `X-Correlation-ID`
- รองรับคำขอ order ล่าสุด (`latest`, `last`, `most recent`), order ทั้งหมด (`all`, `every`, `each`, `order history` หรือ `orders` แบบพหูพจน์) และค้น order ด้วย ID เช่น `O1001`; ถ้าระบุ order แบบเอกพจน์โดยไม่บอกช่วง ระบบใช้รายการล่าสุด
- การค้น order ทั้งหมดอ่านผ่านหน้า ๆ ละไม่เกิน 50 รายการ โดยเรียงจากใหม่ไปเก่า
- Coordinator ค้น Agent Card ของผู้สมัครและจับคู่ `skills[].id` กับ capability ที่ต้องการ ก่อนส่ง task แบบ A2A ผ่าน Kong; cache ในหน่วยความจำ 5 นาทีช่วยลด discovery traffic ส่วน Agent Card เผย metadata/skills และ A2A จัดการรูปแบบข้อความกับ task lifecycle
- หากขั้นหลังล้มเหลวหลังจากได้ข้อมูลบางส่วนแล้ว ระบบตอบ `200` พร้อม `status: "partial"`, `answer`, ข้อมูลที่ดึงสำเร็จ และ `issues`; ถ้าคำขอมีทั้ง customer กับ order จะตรวจ `order.customer_id` ให้ตรงกับ customer ก่อนตอบ
- คำขอที่มี customer ID หรือ order ID หลายรายการจะถูกปฏิเสธด้วย `400 AMBIGUOUS_QUERY` เพื่อไม่เลือก ID แรกอย่างเงียบ ๆ
- Specialist Agent เรียก API ผ่าน Kong ด้วย service key; API จึงเป็นทางเดียวที่อ่านข้อมูลจากฐานข้อมูล
- การตัดสินใจเป็น deterministic และไม่มี LLM, prompt หรือ API key ของผู้ให้บริการโมเดล จึงทำซ้ำผลได้ แต่ไม่เข้าใจคำถามทั่วไปนอกเหนือ ID และคำสำคัญที่รองรับ
- A2A ใช้สื่อสารระหว่าง Agent; การเรียก REST API เป็นการอ่านข้อมูล/เรียก capability ของระบบ ไม่ใช่การส่งงาน Agent-to-Agent

ตัวอย่างคำถามที่ Coordinator รองรับ: `C001`, `show customer C001`, `Name of C001 and their Order` (ตีความเป็น order ล่าสุด), `latest order for C001`, `Show all orders for C001`, `Show orders for C001`, `O1001` และคำถามที่ระบุทั้ง customer กับ order ID

## API routes

| Method | Route | รายละเอียด |
|---|---|---|
| GET | `/api/v1/customers/{customerId}` | อ่านข้อมูล customer |
| GET | `/api/v1/orders/{orderId}` | อ่าน order |
| GET | `/api/v1/orders?customerId=C001&limit=50&offset=0` | แสดง order ใหม่ไปเก่าแบบแบ่งหน้า; `limit` 1–50, `offset` 0–1,000,000 |
| POST | `/api/v1/agent/query` | มอบหมายงานให้ Coordinator |

ดูสัญญา API เพิ่มเติมที่ [OpenAPI](openapi/openapi.yaml) และเรียกตัวอย่างได้จาก [Postman collection](postman/Partilon-Assessment.postman_collection.json)

## ความปลอดภัยและความล้มเหลว

- Kong DB-less โหลด route/plugin จาก `kong/kong.yml`; ทุก route ต้องมี API key ใน `apikey`
- Demo ใช้ `demo-client-key` สำหรับ client, `coordinator-a2a-key` สำหรับ A2A ระหว่าง Coordinator กับ Agents และ `agent-internal-key` สำหรับ Agent เรียก managed APIs; แต่ละ consumer ถูกจำกัด 30 requests ต่อนาทีด้วย rate limiting แบบ local
- Kong สร้างหรือคง `X-Correlation-ID` เดิมไว้ แล้วส่งต่อผ่าน Coordinator, A2A task และ managed API calls; response และ logs ใช้ ID เดียวกัน
- Business API ตอบ 404 เมื่อไม่มี record; Agent query ตอบ `404` เมื่อไม่พบข้อมูล และตอบ `200 partial` เมื่อขั้นถัดไปล้มเหลวหลังมีผลสำเร็จแล้ว; ความล้มเหลวที่เกิดก่อนมีผลตอบ `503` หรือ `504` ตามสาเหตุ ห้าม Agent สร้างข้อมูลแทนผลที่ดึงไม่ได้
- ลองกรณีไม่มี key: `curl.exe -i http://localhost:8000/api/v1/customers/C001`; เรียกเกิน 30 ครั้งต่อนาทีด้วย key เดิมเพื่อดู `429`
- ลอง partial result เมื่อ dependency ล่ม: `docker compose stop order-api` แล้วถาม `Find customer C001 and tell me their latest order status`; ควรได้ `200` พร้อม customer, `status: "partial"` และ issue ว่าดึง order ไม่ได้ จากนั้นคืนระบบด้วย `docker compose start order-api`
- Kong สร้าง ID ให้อัตโนมัติ; หากต้องการกำหนด ID เพื่อไล่ trace เอง ส่ง `X-Correlation-ID` เข้ามาได้:

```powershell
curl.exe -i -H "apikey: demo-client-key" -H "X-Correlation-ID: trace-demo-001" http://localhost:8000/api/v1/customers/C001
curl.exe -i -X POST http://localhost:8000/api/v1/agent/query -H "apikey: demo-client-key" -H "X-Correlation-ID: trace-demo-002" -H "Content-Type: application/json" -d '{"query":"Find customer C001 and tell me their latest order status"}'
```

ค้น ID จาก response header `X-Correlation-ID` ใน logs ของ Kong, Coordinator, specialist agents และ APIs:

```powershell
docker compose logs -f kong coordinator customer-agent order-agent customer-api order-api
```

`docker compose down` หยุด services แต่เก็บข้อมูลไว้ใน volume; `docker compose down -v` ลบฐานข้อมูล demo และ seed ทั้งหมด

## โครงสร้างโฟลเดอร์

- `services/`: Express APIs, Coordinator และ specialist Agents
- `packages/shared/`: HTTP errors, request ID/logging, PostgreSQL pool และ A2A adapters
- `db/init.sql`: สร้าง database/roles/tables และ seed `C001`, `O1001`
- `kong/kong.yml`: declarative services, routes, key authentication และ rate limit
- `openapi/openapi.yaml`: API contract
- `postman/`: collection สำหรับสถานการณ์สาธิต
- `docs/architecture.md`: flow, decisions, assumptions และ limitations

## แผนอ่านเพื่อเรียนรู้และเลือก Agent technology

1. อ่าน [A2A Protocol](https://a2a-protocol.org/latest/) เพื่อเข้าใจ Agent Card, task และการสื่อสารระหว่าง Agent; ดู [A2A JavaScript SDK](https://github.com/a2aproject/a2a-js) สำหรับ Express adapter และ client ในตัวอย่างนี้
2. เทียบ orchestration แบบเขียนลำดับแน่นอนกับแบบให้โมเดลตัดสินใจใน [OpenAI Agents SDK: multi-agent](https://openai.github.io/openai-agents-js/guides/multi-agent/) และอ่าน [tools guide](https://openai.github.io/openai-agents-js/guides/tools/) เรื่องการเปิด capability ให้ agent เรียกใช้ เอกสารนี้เป็นแนวทางเรียนต่อ; โค้ดต้นแบบไม่ได้ติดตั้ง SDK ดังกล่าว
3. ทบทวน [Express 5 API](https://expressjs.com/en/5x/api/), [Express error handling](https://expressjs.com/en/5x/guide/error-handling/) และ [node-postgres pooling](https://node-postgres.com/features/pooling)
4. ทำความเข้าใจ [Kong DB-less](https://docs.konghq.com/gateway/latest/production/deployment-topologies/db-less-and-declarative-config/), [key authentication](https://docs.konghq.com/hub/kong-inc/key-auth/) และ [rate limiting](https://docs.konghq.com/hub/kong-inc/rate-limiting/configuration/)
5. เปรียบเทียบทางเลือก Gateway กับ [Apache APISIX architecture](https://apisix.apache.org/docs/apisix/architecture-design/apisix/): เดโมนี้เลือก Kong เพราะ declarative DB-less config ทำให้แพ็กและรีวิว topology ได้ในไฟล์เดียว; ก่อนใช้งานจริงให้เทียบความถนัดของทีม, plugin/feature ที่ต้องใช้, วิธีจัดการ config, observability และรูปแบบ deployment

## Technology choices

- **Node.js 22 + TypeScript:** ใช้ runtime ที่รองรับ A2A JavaScript SDK และช่วยตรวจชนิดข้อมูลระหว่างพัฒนา
- **Express 5:** ใช้ทำ Customer API, Order API, Coordinator และ HTTP adapter ของ Agents
- **PostgreSQL 17:** ใช้เก็บข้อมูล customer และ order ในฐานข้อมูลแยกกันเชิงตรรกะ
- **Kong Gateway 3.9.4:** เลือก DB-less declarative configuration เพื่อเก็บ routes และ plugins ไว้ใน `kong/kong.yml` และเริ่มระบบได้ด้วย Compose
- **A2A JavaScript SDK 1.0.1:** ใช้ Agent Cards และ task lifecycle สำหรับการค้นหา Agent และมอบหมายงานระหว่าง Agents
- **Pino และ Docker Compose:** Pino เขียน structured application logs ไป stdout; Docker Compose ใช้รันและดู logs ของ stack ในเครื่อง
- **ไม่มี LLM framework:** การวางแผนเป็น deterministic TypeScript เพื่อให้ผลซ้ำได้และไม่ต้องใช้ model API key

## Architecture decisions

- แยก Customer API และ Order API ตามเจ้าของข้อมูล; แต่ละ API เชื่อมต่อเฉพาะฐานข้อมูลและ role ของตน Agent อ่านข้อมูลผ่าน API ไม่เชื่อมฐานข้อมูลโดยตรง
- ให้ client และการเรียก HTTP/A2A ระหว่าง services ผ่าน Kong เพื่อให้ gateway ใช้ authentication, rate limiting และ correlation ID ในจุดเดียว
- Coordinator ทำงานแบบ **Plan → Discover → Execute → Respond**: สร้างแผน, ค้น Agent Card ผ่าน Kong, เลือก Agent จาก advertised skill แล้วรัน A2A tasks ตามลำดับ
- Coordinator กับ specialist Agents สื่อสารด้วย A2A; Agents เรียก business REST APIs ผ่าน Kong เพื่ออ่านข้อมูล
- กำหนดความหมาย query ให้แน่นอน: ระบุ `latest` เพื่อเอารายการล่าสุด, ระบุ `all` หรือพหูพจน์เพื่อเอาทั้งหมด, และระบุ order ID เพื่อค้นรายการนั้น; order เอกพจน์ที่ไม่ระบุช่วงหมายถึงรายการล่าสุด
- ส่ง `X-Correlation-ID` ต่อระหว่าง Kong, Express services และ A2A tasks เพื่อค้น log ของธุรกรรมเดียวกัน

## Assumptions

- ประเมินและสาธิตบนเครื่องเดียวด้วย Docker Compose; seed `C001`, `O1001` และรายการตัวอย่างเป็นข้อมูล demo
- customer และ order แยกเป็นคนละ database และ role แต่ใช้ PostgreSQL container เดียว เพื่อลดภาระ setup ในกรอบ assessment
- การขอรายการ order ทั้งหมดมีเพดานไม่เกิน 50 รายการต่อ query; API สำหรับ pagination รองรับการอ่านเป็นหน้า
- คำถามที่ระบบต้องรองรับอยู่ในขอบเขต customer/order lookup และตัวอย่างภาษาไทย/อังกฤษที่ระบุใน README
- API keys และรหัสผ่านในไฟล์ config เป็นค่า demo สำหรับ local assessment เท่านั้น

## Known limitations

- Coordinator ใช้กฎและ keyword ที่กำหนดไว้ จึงไม่เข้าใจคำถามทั่วไปนอกขอบเขตที่รองรับ และอาจต้องเพิ่มกฎเมื่อเพิ่มรูปแบบคำถาม
- มี Kong instance เดียวและ rate limit แบบ local จึงไม่มี quota ที่ประสานกันระหว่างหลาย gateway nodes
- Customer database และ Order database อยู่ใน PostgreSQL instance เดียว จึงยังใช้ instance หรือ failure domain ร่วมกัน
- Agent task state และ cache ของ Agent Cards อยู่ใน memory; restart แล้ว task state หาย และ cache อาจใช้ข้อมูล Agent Card เดิมได้ถึง 5 นาที
- Kong access logs และ Pino logs ดูจาก Docker stdout; ไม่มีหน้า dashboard หรือระบบค้น log แบบถาวร และ access log ปัจจุบันไม่ได้บันทึกชื่อ Consumer
- Kong ป้องกันเส้นทางที่เปิดผ่าน gateway ด้วย API keys แต่ Express Agent endpoints บน Compose network ยังไม่มีการยืนยันตัวตนเฉพาะ หากเรียกข้าม Kong โดยตรง

## Incomplete functionality

- ยังไม่มี LLM-based planning หรือการตอบคำถามแบบ conversational ทั่วไป
- ยังไม่มี persistent A2A task history, resume/retry หลัง Agent restart หรือ distributed tracing backend
- ยังไม่มี Kong Manager, traffic analytics UI หรือ central log retention/search service ใน Compose stack
- Automated tests ครอบคลุม planner เป็นหลัก; Postman collection ใช้ทดสอบ API และสถานการณ์สาธิตด้วยตนเอง ยังไม่มี automated end-to-end test ครอบคลุมทุก service และ failure scenario
- ยังไม่มี production secret management, workload identity หรือ hardening สำหรับการ deploy นอกเครื่อง assessment
