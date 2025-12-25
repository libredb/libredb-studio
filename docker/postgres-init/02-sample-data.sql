-- Sample data for LibreDB Studio testing
-- This runs on libredb_dev database

\c libredb_dev

-- ============================================
-- SCHEMA SETUP
-- ============================================
CREATE SCHEMA IF NOT EXISTS app;
SET search_path TO app, public;

-- ============================================
-- TABLES
-- ============================================

-- Categories table
CREATE TABLE IF NOT EXISTS app.categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    parent_id INTEGER REFERENCES app.categories(id),
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_categories_parent ON app.categories(parent_id);
CREATE INDEX idx_categories_slug ON app.categories(slug);

-- Customers table
CREATE TABLE IF NOT EXISTS app.customers (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    date_of_birth DATE,
    gender VARCHAR(10),
    avatar_url VARCHAR(500),
    loyalty_points INTEGER DEFAULT 0,
    tier VARCHAR(20) DEFAULT 'bronze',
    is_verified BOOLEAN DEFAULT false,
    notes TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_customers_email ON app.customers(email);
CREATE INDEX idx_customers_tier ON app.customers(tier);
CREATE INDEX idx_customers_created_at ON app.customers(created_at);

-- Customer addresses
CREATE TABLE IF NOT EXISTS app.customer_addresses (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES app.customers(id) ON DELETE CASCADE,
    type VARCHAR(20) DEFAULT 'shipping',
    is_default BOOLEAN DEFAULT false,
    full_name VARCHAR(200),
    street_address VARCHAR(500) NOT NULL,
    apartment VARCHAR(100),
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100),
    postal_code VARCHAR(20) NOT NULL,
    country VARCHAR(100) DEFAULT 'Turkey',
    phone VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_customer_addresses_customer ON app.customer_addresses(customer_id);

-- Products table
CREATE TABLE IF NOT EXISTS app.products (
    id SERIAL PRIMARY KEY,
    sku VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    short_description VARCHAR(500),
    price DECIMAL(10, 2) NOT NULL,
    compare_at_price DECIMAL(10, 2),
    cost_price DECIMAL(10, 2),
    stock_quantity INTEGER DEFAULT 0,
    low_stock_threshold INTEGER DEFAULT 10,
    category_id INTEGER REFERENCES app.categories(id),
    brand VARCHAR(100),
    weight_kg DECIMAL(5, 2),
    dimensions JSONB,
    images JSONB DEFAULT '[]',
    tags TEXT[],
    is_active BOOLEAN DEFAULT true,
    is_featured BOOLEAN DEFAULT false,
    rating_avg DECIMAL(2, 1) DEFAULT 0,
    rating_count INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_products_sku ON app.products(sku);
CREATE INDEX idx_products_slug ON app.products(slug);
CREATE INDEX idx_products_category ON app.products(category_id);
CREATE INDEX idx_products_price ON app.products(price);
CREATE INDEX idx_products_brand ON app.products(brand);
CREATE INDEX idx_products_tags ON app.products USING GIN(tags);
CREATE INDEX idx_products_is_active ON app.products(is_active) WHERE is_active = true;

-- Orders table
CREATE TABLE IF NOT EXISTS app.orders (
    id SERIAL PRIMARY KEY,
    order_number VARCHAR(50) UNIQUE NOT NULL,
    customer_id INTEGER REFERENCES app.customers(id),
    status VARCHAR(30) DEFAULT 'pending',
    payment_status VARCHAR(30) DEFAULT 'pending',
    payment_method VARCHAR(50),
    subtotal DECIMAL(12, 2) NOT NULL,
    tax_amount DECIMAL(12, 2) DEFAULT 0,
    shipping_amount DECIMAL(12, 2) DEFAULT 0,
    discount_amount DECIMAL(12, 2) DEFAULT 0,
    total_amount DECIMAL(12, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'TRY',
    shipping_address JSONB,
    billing_address JSONB,
    notes TEXT,
    internal_notes TEXT,
    ip_address INET,
    user_agent TEXT,
    shipped_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    cancelled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_orders_customer ON app.orders(customer_id);
CREATE INDEX idx_orders_status ON app.orders(status);
CREATE INDEX idx_orders_payment_status ON app.orders(payment_status);
CREATE INDEX idx_orders_created_at ON app.orders(created_at);
CREATE INDEX idx_orders_order_number ON app.orders(order_number);

-- Order items table
CREATE TABLE IF NOT EXISTS app.order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES app.orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES app.products(id),
    product_name VARCHAR(255) NOT NULL,
    product_sku VARCHAR(50) NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    discount_percent DECIMAL(5, 2) DEFAULT 0,
    total_price DECIMAL(12, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_order_items_order ON app.order_items(order_id);
CREATE INDEX idx_order_items_product ON app.order_items(product_id);

-- Product reviews
CREATE TABLE IF NOT EXISTS app.product_reviews (
    id SERIAL PRIMARY KEY,
    product_id INTEGER REFERENCES app.products(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES app.customers(id),
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(200),
    content TEXT,
    is_verified_purchase BOOLEAN DEFAULT false,
    is_approved BOOLEAN DEFAULT false,
    helpful_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_reviews_product ON app.product_reviews(product_id);
CREATE INDEX idx_reviews_customer ON app.product_reviews(customer_id);
CREATE INDEX idx_reviews_rating ON app.product_reviews(rating);

-- Inventory movements
CREATE TABLE IF NOT EXISTS app.inventory_movements (
    id BIGSERIAL PRIMARY KEY,
    product_id INTEGER REFERENCES app.products(id),
    movement_type VARCHAR(30) NOT NULL,
    quantity INTEGER NOT NULL,
    quantity_before INTEGER NOT NULL,
    quantity_after INTEGER NOT NULL,
    reference_type VARCHAR(50),
    reference_id INTEGER,
    notes TEXT,
    created_by VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_inventory_product ON app.inventory_movements(product_id);
CREATE INDEX idx_inventory_type ON app.inventory_movements(movement_type);
CREATE INDEX idx_inventory_created_at ON app.inventory_movements(created_at);

-- Coupons
CREATE TABLE IF NOT EXISTS app.coupons (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    discount_type VARCHAR(20) NOT NULL,
    discount_value DECIMAL(10, 2) NOT NULL,
    min_order_amount DECIMAL(10, 2),
    max_discount_amount DECIMAL(10, 2),
    usage_limit INTEGER,
    usage_count INTEGER DEFAULT 0,
    starts_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_coupons_code ON app.coupons(code);
CREATE INDEX idx_coupons_active ON app.coupons(is_active, starts_at, expires_at);

-- Audit log
CREATE TABLE IF NOT EXISTS app.audit_log (
    id BIGSERIAL PRIMARY KEY,
    table_name VARCHAR(100) NOT NULL,
    record_id INTEGER,
    action VARCHAR(20) NOT NULL,
    old_values JSONB,
    new_values JSONB,
    changed_by VARCHAR(100),
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_table ON app.audit_log(table_name);
CREATE INDEX idx_audit_record ON app.audit_log(table_name, record_id);
CREATE INDEX idx_audit_created_at ON app.audit_log(created_at);

-- ============================================
-- SEED DATA
-- ============================================

-- Categories
INSERT INTO app.categories (name, slug, description, parent_id, sort_order) VALUES
    ('Electronics', 'electronics', 'Electronic devices and gadgets', NULL, 1),
    ('Computers', 'computers', 'Laptops, desktops and accessories', 1, 1),
    ('Smartphones', 'smartphones', 'Mobile phones and tablets', 1, 2),
    ('Audio', 'audio', 'Headphones, speakers and audio equipment', 1, 3),
    ('Fashion', 'fashion', 'Clothing and accessories', NULL, 2),
    ('Men', 'men', 'Mens clothing', 5, 1),
    ('Women', 'women', 'Womens clothing', 5, 2),
    ('Home & Garden', 'home-garden', 'Home decor and garden supplies', NULL, 3),
    ('Kitchen', 'kitchen', 'Kitchen appliances and utensils', 8, 1),
    ('Furniture', 'furniture', 'Indoor and outdoor furniture', 8, 2),
    ('Sports', 'sports', 'Sports equipment and outdoor gear', NULL, 4),
    ('Books', 'books', 'Books, e-books and audiobooks', NULL, 5)
ON CONFLICT (slug) DO NOTHING;

-- Customers (50 customers)
INSERT INTO app.customers (email, first_name, last_name, phone, date_of_birth, gender, loyalty_points, tier, is_verified) VALUES
    ('ahmet.yilmaz@email.com', 'Ahmet', 'Yilmaz', '+905551234501', '1985-03-15', 'male', 2500, 'gold', true),
    ('ayse.demir@email.com', 'Ayse', 'Demir', '+905551234502', '1990-07-22', 'female', 1500, 'silver', true),
    ('mehmet.kaya@email.com', 'Mehmet', 'Kaya', '+905551234503', '1988-11-08', 'male', 3500, 'platinum', true),
    ('fatma.celik@email.com', 'Fatma', 'Celik', '+905551234504', '1995-01-30', 'female', 800, 'bronze', true),
    ('ali.ozturk@email.com', 'Ali', 'Ozturk', '+905551234505', '1982-09-12', 'male', 1200, 'silver', true),
    ('zeynep.arslan@email.com', 'Zeynep', 'Arslan', '+905551234506', '1993-04-25', 'female', 4200, 'platinum', true),
    ('mustafa.sahin@email.com', 'Mustafa', 'Sahin', '+905551234507', '1978-12-03', 'male', 600, 'bronze', false),
    ('elif.yildiz@email.com', 'Elif', 'Yildiz', '+905551234508', '1991-06-18', 'female', 2100, 'gold', true),
    ('emre.kurt@email.com', 'Emre', 'Kurt', '+905551234509', '1987-02-28', 'male', 950, 'bronze', true),
    ('selin.dogan@email.com', 'Selin', 'Dogan', '+905551234510', '1994-08-14', 'female', 1800, 'silver', true),
    ('burak.aydin@email.com', 'Burak', 'Aydin', '+905551234511', '1986-05-09', 'male', 2800, 'gold', true),
    ('deniz.kilic@email.com', 'Deniz', 'Kilic', '+905551234512', '1992-10-21', 'female', 550, 'bronze', false),
    ('can.erdogan@email.com', 'Can', 'Erdogan', '+905551234513', '1989-01-17', 'male', 3100, 'platinum', true),
    ('ece.polat@email.com', 'Ece', 'Polat', '+905551234514', '1996-07-04', 'female', 420, 'bronze', true),
    ('kerem.ozdemir@email.com', 'Kerem', 'Ozdemir', '+905551234515', '1984-03-29', 'male', 1650, 'silver', true),
    ('ipek.korkmaz@email.com', 'Ipek', 'Korkmaz', '+905551234516', '1997-11-11', 'female', 2300, 'gold', true),
    ('tolga.aksoy@email.com', 'Tolga', 'Aksoy', '+905551234517', '1981-08-06', 'male', 750, 'bronze', true),
    ('melis.cetin@email.com', 'Melis', 'Cetin', '+905551234518', '1993-02-14', 'female', 1950, 'silver', true),
    ('oguz.karaca@email.com', 'Oguz', 'Karaca', '+905551234519', '1990-12-25', 'male', 5100, 'platinum', true),
    ('pinar.guler@email.com', 'Pinar', 'Guler', '+905551234520', '1988-04-02', 'female', 1100, 'silver', true),
    ('serkan.yalcin@email.com', 'Serkan', 'Yalcin', '+905551234521', '1983-09-19', 'male', 2650, 'gold', true),
    ('ceren.koc@email.com', 'Ceren', 'Koc', '+905551234522', '1995-06-08', 'female', 380, 'bronze', false),
    ('baran.tekin@email.com', 'Baran', 'Tekin', '+905551234523', '1979-01-23', 'male', 4500, 'platinum', true),
    ('gamze.sen@email.com', 'Gamze', 'Sen', '+905551234524', '1992-07-31', 'female', 1400, 'silver', true),
    ('arda.cinar@email.com', 'Arda', 'Cinar', '+905551234525', '1986-11-15', 'male', 2200, 'gold', true)
ON CONFLICT (email) DO NOTHING;

-- Customer addresses
INSERT INTO app.customer_addresses (customer_id, type, is_default, full_name, street_address, apartment, city, state, postal_code, country, phone)
SELECT
    c.id, 'shipping', true, c.first_name || ' ' || c.last_name,
    'Ataturk Caddesi No: ' || (c.id * 10),
    'Daire ' || (c.id % 10 + 1),
    CASE (c.id % 5)
        WHEN 0 THEN 'Istanbul'
        WHEN 1 THEN 'Ankara'
        WHEN 2 THEN 'Izmir'
        WHEN 3 THEN 'Bursa'
        ELSE 'Antalya'
    END,
    CASE (c.id % 5)
        WHEN 0 THEN 'Kadikoy'
        WHEN 1 THEN 'Cankaya'
        WHEN 2 THEN 'Konak'
        WHEN 3 THEN 'Nilufer'
        ELSE 'Muratpasa'
    END,
    LPAD((34000 + c.id * 100)::text, 5, '0'),
    'Turkey',
    c.phone
FROM app.customers c;

-- Products (30 products)
INSERT INTO app.products (sku, name, slug, description, short_description, price, compare_at_price, cost_price, stock_quantity, category_id, brand, weight_kg, is_active, is_featured, rating_avg, rating_count, view_count) VALUES
    ('LAPTOP-001', 'MacBook Pro 14" M3', 'macbook-pro-14-m3', 'Apple MacBook Pro with M3 chip, 16GB RAM, 512GB SSD. Perfect for professionals.', 'Powerful laptop for professionals', 89999.99, 94999.99, 75000.00, 45, 2, 'Apple', 1.55, true, true, 4.8, 124, 5420),
    ('LAPTOP-002', 'Dell XPS 15', 'dell-xps-15', 'Dell XPS 15 with Intel i9, 32GB RAM, 1TB SSD, OLED display.', '15-inch premium ultrabook', 74999.99, NULL, 62000.00, 32, 2, 'Dell', 1.86, true, true, 4.6, 89, 3210),
    ('LAPTOP-003', 'ThinkPad X1 Carbon', 'thinkpad-x1-carbon', 'Lenovo ThinkPad X1 Carbon Gen 11, business-class ultrabook.', 'Business ultrabook', 64999.99, 69999.99, 52000.00, 28, 2, 'Lenovo', 1.12, true, false, 4.7, 67, 2890),
    ('PHONE-001', 'iPhone 15 Pro Max', 'iphone-15-pro-max', 'Apple iPhone 15 Pro Max 256GB with A17 Pro chip and titanium design.', 'Latest flagship iPhone', 74999.99, NULL, 65000.00, 120, 3, 'Apple', 0.22, true, true, 4.9, 256, 12500),
    ('PHONE-002', 'Samsung Galaxy S24 Ultra', 'samsung-galaxy-s24-ultra', 'Samsung Galaxy S24 Ultra with S Pen, 200MP camera, AI features.', 'Premium Android flagship', 69999.99, 74999.99, 58000.00, 85, 3, 'Samsung', 0.23, true, true, 4.7, 198, 9800),
    ('PHONE-003', 'Google Pixel 8 Pro', 'google-pixel-8-pro', 'Google Pixel 8 Pro with Tensor G3, best-in-class camera.', 'Pure Android experience', 44999.99, NULL, 38000.00, 65, 3, 'Google', 0.21, true, false, 4.5, 87, 4560),
    ('AUDIO-001', 'AirPods Pro 2', 'airpods-pro-2', 'Apple AirPods Pro 2nd Gen with USB-C, active noise cancellation.', 'Premium wireless earbuds', 9999.99, 10999.99, 8000.00, 200, 4, 'Apple', 0.05, true, true, 4.8, 445, 15600),
    ('AUDIO-002', 'Sony WH-1000XM5', 'sony-wh-1000xm5', 'Sony WH-1000XM5 wireless noise canceling headphones.', 'Industry-leading NC headphones', 12999.99, NULL, 10500.00, 75, 4, 'Sony', 0.25, true, true, 4.9, 312, 8900),
    ('AUDIO-003', 'Bose QuietComfort Ultra', 'bose-quietcomfort-ultra', 'Bose QuietComfort Ultra headphones with spatial audio.', 'Premium comfort headphones', 14999.99, 15999.99, 12000.00, 50, 4, 'Bose', 0.25, true, false, 4.7, 156, 5400),
    ('WATCH-001', 'Apple Watch Ultra 2', 'apple-watch-ultra-2', 'Apple Watch Ultra 2, the most rugged and capable Apple Watch.', 'Adventure smartwatch', 34999.99, NULL, 29000.00, 40, 1, 'Apple', 0.06, true, true, 4.8, 89, 6700),
    ('WATCH-002', 'Samsung Galaxy Watch 6', 'samsung-galaxy-watch-6', 'Samsung Galaxy Watch 6 Classic with rotating bezel.', 'Classic smartwatch design', 14999.99, 16999.99, 12000.00, 90, 1, 'Samsung', 0.05, true, false, 4.5, 134, 4500),
    ('TABLET-001', 'iPad Pro 12.9" M2', 'ipad-pro-12-m2', 'Apple iPad Pro 12.9-inch with M2 chip, Liquid Retina XDR.', 'Professional tablet', 54999.99, NULL, 46000.00, 35, 3, 'Apple', 0.68, true, true, 4.8, 167, 7800),
    ('TABLET-002', 'Samsung Galaxy Tab S9 Ultra', 'samsung-galaxy-tab-s9-ultra', 'Samsung Galaxy Tab S9 Ultra with S Pen, 14.6-inch display.', 'Large Android tablet', 49999.99, 54999.99, 42000.00, 25, 3, 'Samsung', 0.73, true, false, 4.6, 78, 3200),
    ('KB-001', 'Keychron K8 Pro', 'keychron-k8-pro', 'Keychron K8 Pro wireless mechanical keyboard, hot-swappable.', 'Premium mechanical keyboard', 4499.99, NULL, 3500.00, 150, 2, 'Keychron', 1.05, true, false, 4.7, 234, 8900),
    ('KB-002', 'Logitech MX Keys', 'logitech-mx-keys', 'Logitech MX Keys wireless illuminated keyboard.', 'Comfortable typing keyboard', 3999.99, 4499.99, 3200.00, 120, 2, 'Logitech', 0.81, true, false, 4.6, 189, 6700),
    ('MOUSE-001', 'Logitech MX Master 3S', 'logitech-mx-master-3s', 'Logitech MX Master 3S wireless performance mouse.', 'Ergonomic wireless mouse', 4299.99, NULL, 3400.00, 180, 2, 'Logitech', 0.14, true, true, 4.8, 312, 11200),
    ('MOUSE-002', 'Apple Magic Mouse', 'apple-magic-mouse', 'Apple Magic Mouse with Multi-Touch surface.', 'Minimalist Apple mouse', 3499.99, NULL, 2800.00, 95, 2, 'Apple', 0.10, true, false, 4.2, 156, 5600),
    ('MONITOR-001', 'LG UltraFine 32UN880', 'lg-ultrafine-32un880', 'LG 32-inch UltraFine 4K Ergo monitor with USB-C.', 'Ergonomic 4K monitor', 24999.99, 27999.99, 20000.00, 30, 2, 'LG', 9.80, true, true, 4.7, 89, 4300),
    ('MONITOR-002', 'Dell UltraSharp U2723QE', 'dell-ultrasharp-u2723qe', 'Dell 27-inch 4K USB-C Hub monitor with IPS Black.', 'Professional USB-C monitor', 22999.99, NULL, 18500.00, 25, 2, 'Dell', 6.64, true, false, 4.8, 67, 3100),
    ('CHARGER-001', 'Anker 737 GaNPrime', 'anker-737-ganprime', 'Anker 737 120W GaN charger with 3 ports.', 'High-power GaN charger', 2999.99, 3499.99, 2400.00, 300, 1, 'Anker', 0.19, true, false, 4.6, 445, 12300),
    ('CASE-001', 'Apple Leather Case iPhone 15 Pro', 'apple-leather-case-iphone-15-pro', 'Apple genuine leather case for iPhone 15 Pro.', 'Premium iPhone case', 2499.99, NULL, 2000.00, 250, 3, 'Apple', 0.03, true, false, 4.5, 189, 7800),
    ('TSHIRT-001', 'Basic Cotton T-Shirt', 'basic-cotton-tshirt-men', 'Premium cotton basic t-shirt for men. Available in multiple colors.', 'Comfortable everyday tee', 299.99, 399.99, 150.00, 500, 6, 'BasicWear', 0.20, true, false, 4.4, 567, 23400),
    ('TSHIRT-002', 'Premium V-Neck Tee', 'premium-vneck-tee-women', 'Soft premium v-neck t-shirt for women.', 'Elegant v-neck design', 349.99, NULL, 180.00, 450, 7, 'StyleCo', 0.18, true, false, 4.5, 423, 18900),
    ('JEANS-001', 'Slim Fit Denim Jeans', 'slim-fit-denim-jeans-men', 'Classic slim fit denim jeans for men. Stretch comfort.', 'Timeless denim style', 799.99, 999.99, 400.00, 200, 6, 'DenimX', 0.65, true, true, 4.6, 234, 9800),
    ('DRESS-001', 'Floral Summer Dress', 'floral-summer-dress', 'Beautiful floral print summer dress. Light and breezy.', 'Perfect for summer', 599.99, NULL, 300.00, 150, 7, 'SummerStyle', 0.30, true, true, 4.7, 178, 7600),
    ('COFFEE-001', 'Nespresso Vertuo Next', 'nespresso-vertuo-next', 'Nespresso Vertuo Next coffee machine. One-touch brewing.', 'Premium coffee maker', 4999.99, 5499.99, 4000.00, 60, 9, 'Nespresso', 4.00, true, true, 4.6, 312, 11200),
    ('BLENDER-001', 'Vitamix E310', 'vitamix-e310', 'Vitamix E310 professional-grade blender.', 'Professional blender', 12999.99, NULL, 10500.00, 35, 9, 'Vitamix', 5.20, true, false, 4.9, 145, 5600),
    ('CHAIR-001', 'Herman Miller Aeron', 'herman-miller-aeron', 'Herman Miller Aeron ergonomic office chair, size B.', 'Iconic ergonomic chair', 54999.99, 59999.99, 45000.00, 15, 10, 'Herman Miller', 19.00, true, true, 4.8, 89, 4300),
    ('DESK-001', 'IKEA BEKANT Standing Desk', 'ikea-bekant-standing-desk', 'IKEA BEKANT sit/stand desk, 160x80 cm.', 'Adjustable standing desk', 12999.99, NULL, 10000.00, 40, 10, 'IKEA', 35.00, true, false, 4.4, 234, 8900),
    ('BOOK-001', 'Clean Code', 'clean-code-robert-martin', 'Clean Code by Robert C. Martin. A handbook of agile software craftsmanship.', 'Software development classic', 349.99, NULL, 200.00, 100, 12, 'Pearson', 0.80, true, true, 4.9, 567, 23400)
ON CONFLICT (sku) DO NOTHING;

-- Orders (100 orders)
DO $$
DECLARE
    i INTEGER;
    cust_id INTEGER;
    ord_status VARCHAR(30);
    pay_status VARCHAR(30);
    ord_total DECIMAL(12,2);
    ord_date TIMESTAMP WITH TIME ZONE;
BEGIN
    FOR i IN 1..100 LOOP
        -- Random customer
        SELECT id INTO cust_id FROM app.customers ORDER BY RANDOM() LIMIT 1;

        -- Random status
        ord_status := (ARRAY['pending', 'processing', 'shipped', 'delivered', 'completed', 'cancelled'])[floor(random() * 6 + 1)];
        pay_status := CASE ord_status
            WHEN 'cancelled' THEN 'refunded'
            WHEN 'pending' THEN 'pending'
            ELSE 'paid'
        END;

        -- Random total
        ord_total := round((random() * 50000 + 500)::numeric, 2);

        -- Random date in last 90 days
        ord_date := NOW() - (random() * INTERVAL '90 days');

        INSERT INTO app.orders (order_number, customer_id, status, payment_status, payment_method, subtotal, tax_amount, shipping_amount, discount_amount, total_amount, shipping_address, created_at, updated_at)
        VALUES (
            'ORD-' || TO_CHAR(ord_date, 'YYYYMMDD') || '-' || LPAD(i::text, 4, '0'),
            cust_id,
            ord_status,
            pay_status,
            (ARRAY['credit_card', 'debit_card', 'bank_transfer', 'cash_on_delivery'])[floor(random() * 4 + 1)],
            ord_total * 0.82,
            ord_total * 0.18,
            CASE WHEN ord_total > 1000 THEN 0 ELSE 49.99 END,
            CASE WHEN random() > 0.7 THEN ord_total * 0.1 ELSE 0 END,
            ord_total,
            (SELECT jsonb_build_object(
                'full_name', ca.full_name,
                'street', ca.street_address,
                'city', ca.city,
                'postal_code', ca.postal_code
            ) FROM app.customer_addresses ca WHERE ca.customer_id = cust_id LIMIT 1),
            ord_date,
            ord_date
        ) ON CONFLICT DO NOTHING;
    END LOOP;
END $$;

-- Order items (2-4 items per order)
DO $$
DECLARE
    ord RECORD;
    prod RECORD;
    item_count INTEGER;
    qty INTEGER;
BEGIN
    FOR ord IN SELECT id, total_amount FROM app.orders LOOP
        item_count := floor(random() * 3 + 2);

        FOR prod IN SELECT id, name, sku, price FROM app.products ORDER BY RANDOM() LIMIT item_count LOOP
            qty := floor(random() * 3 + 1);

            INSERT INTO app.order_items (order_id, product_id, product_name, product_sku, quantity, unit_price, total_price)
            VALUES (ord.id, prod.id, prod.name, prod.sku, qty, prod.price, prod.price * qty)
            ON CONFLICT DO NOTHING;
        END LOOP;
    END LOOP;
END $$;

-- Product reviews
DO $$
DECLARE
    prod RECORD;
    cust RECORD;
    review_count INTEGER;
    rating_val INTEGER;
BEGIN
    FOR prod IN SELECT id FROM app.products LOOP
        review_count := floor(random() * 8 + 2);

        FOR cust IN SELECT id FROM app.customers ORDER BY RANDOM() LIMIT review_count LOOP
            rating_val := floor(random() * 2 + 4); -- 4 or 5 stars mostly

            INSERT INTO app.product_reviews (product_id, customer_id, rating, title, content, is_verified_purchase, is_approved, helpful_count, created_at)
            VALUES (
                prod.id,
                cust.id,
                rating_val,
                CASE rating_val
                    WHEN 5 THEN 'Excellent product!'
                    WHEN 4 THEN 'Very good, recommended'
                    WHEN 3 THEN 'Decent product'
                    ELSE 'Could be better'
                END,
                CASE rating_val
                    WHEN 5 THEN 'Absolutely love it! Exceeded my expectations. Fast delivery and great quality.'
                    WHEN 4 THEN 'Good quality product. Works as expected. Would buy again.'
                    WHEN 3 THEN 'It is okay for the price. Does the job but nothing special.'
                    ELSE 'Not what I expected. Quality could be improved.'
                END,
                random() > 0.3,
                true,
                floor(random() * 50),
                NOW() - (random() * INTERVAL '60 days')
            ) ON CONFLICT DO NOTHING;
        END LOOP;
    END LOOP;
END $$;

-- Inventory movements
INSERT INTO app.inventory_movements (product_id, movement_type, quantity, quantity_before, quantity_after, reference_type, notes, created_by, created_at)
SELECT
    p.id,
    'stock_in',
    100,
    p.stock_quantity - 100,
    p.stock_quantity,
    'purchase_order',
    'Initial stock',
    'system',
    NOW() - INTERVAL '30 days'
FROM app.products p;

-- Coupons
INSERT INTO app.coupons (code, description, discount_type, discount_value, min_order_amount, max_discount_amount, usage_limit, starts_at, expires_at, is_active) VALUES
    ('WELCOME10', 'Welcome discount - 10% off', 'percentage', 10, 500, 500, 1000, NOW() - INTERVAL '30 days', NOW() + INTERVAL '90 days', true),
    ('SUMMER25', 'Summer sale - 25% off', 'percentage', 25, 1000, 2500, 500, NOW(), NOW() + INTERVAL '60 days', true),
    ('FLAT500', 'Flat 500 TL off', 'fixed', 500, 2500, NULL, 200, NOW(), NOW() + INTERVAL '30 days', true),
    ('VIP50', 'VIP member discount', 'percentage', 50, 5000, 10000, 50, NOW(), NOW() + INTERVAL '365 days', true),
    ('FREESHIP', 'Free shipping', 'fixed', 49.99, 100, NULL, NULL, NOW() - INTERVAL '60 days', NOW() + INTERVAL '30 days', true)
ON CONFLICT (code) DO NOTHING;

-- ============================================
-- VIEWS
-- ============================================

-- Order summary view
CREATE OR REPLACE VIEW app.order_summary AS
SELECT
    o.id,
    o.order_number,
    c.first_name || ' ' || c.last_name as customer_name,
    c.email as customer_email,
    c.tier as customer_tier,
    o.status,
    o.payment_status,
    o.total_amount,
    COUNT(oi.id) as item_count,
    SUM(oi.quantity) as total_items,
    o.created_at as order_date
FROM app.orders o
JOIN app.customers c ON o.customer_id = c.id
LEFT JOIN app.order_items oi ON o.id = oi.order_id
GROUP BY o.id, o.order_number, c.first_name, c.last_name, c.email, c.tier, o.status, o.payment_status, o.total_amount, o.created_at;

-- Product sales summary
CREATE OR REPLACE VIEW app.product_sales_summary AS
SELECT
    p.id,
    p.sku,
    p.name,
    p.category_id,
    cat.name as category_name,
    p.price,
    p.stock_quantity,
    COALESCE(SUM(oi.quantity), 0) as total_sold,
    COALESCE(SUM(oi.total_price), 0) as total_revenue,
    COALESCE(COUNT(DISTINCT oi.order_id), 0) as order_count,
    p.rating_avg,
    p.view_count
FROM app.products p
LEFT JOIN app.categories cat ON p.category_id = cat.id
LEFT JOIN app.order_items oi ON p.id = oi.product_id
LEFT JOIN app.orders o ON oi.order_id = o.id AND o.status NOT IN ('cancelled')
GROUP BY p.id, p.sku, p.name, p.category_id, cat.name, p.price, p.stock_quantity, p.rating_avg, p.view_count;

-- Customer lifetime value
CREATE OR REPLACE VIEW app.customer_lifetime_value AS
SELECT
    c.id,
    c.email,
    c.first_name || ' ' || c.last_name as full_name,
    c.tier,
    c.loyalty_points,
    COUNT(DISTINCT o.id) as total_orders,
    COALESCE(SUM(o.total_amount), 0) as lifetime_value,
    COALESCE(AVG(o.total_amount), 0) as avg_order_value,
    MIN(o.created_at) as first_order_date,
    MAX(o.created_at) as last_order_date,
    c.created_at as customer_since
FROM app.customers c
LEFT JOIN app.orders o ON c.id = o.customer_id AND o.status NOT IN ('cancelled')
GROUP BY c.id, c.email, c.first_name, c.last_name, c.tier, c.loyalty_points, c.created_at;

-- Daily sales report
CREATE OR REPLACE VIEW app.daily_sales AS
SELECT
    DATE(o.created_at) as sale_date,
    COUNT(DISTINCT o.id) as order_count,
    SUM(o.total_amount) as total_sales,
    AVG(o.total_amount) as avg_order_value,
    COUNT(DISTINCT o.customer_id) as unique_customers
FROM app.orders o
WHERE o.status NOT IN ('cancelled', 'pending')
GROUP BY DATE(o.created_at)
ORDER BY sale_date DESC;

-- ============================================
-- PERMISSIONS
-- ============================================
GRANT USAGE ON SCHEMA app TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA app TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA app TO postgres;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO postgres;

-- ============================================
-- ANALYZE FOR QUERY PLANNER
-- ============================================
ANALYZE app.categories;
ANALYZE app.customers;
ANALYZE app.customer_addresses;
ANALYZE app.products;
ANALYZE app.orders;
ANALYZE app.order_items;
ANALYZE app.product_reviews;
ANALYZE app.inventory_movements;
ANALYZE app.coupons;

-- ============================================
-- GENERATE QUERY STATISTICS
-- ============================================
-- Run sample queries to populate pg_stat_statements
SELECT COUNT(*) FROM app.customers WHERE tier = 'gold';
SELECT * FROM app.products WHERE price > 10000 ORDER BY price DESC LIMIT 10;
SELECT * FROM app.order_summary WHERE status = 'completed' LIMIT 20;
SELECT * FROM app.product_sales_summary ORDER BY total_revenue DESC LIMIT 10;
SELECT * FROM app.customer_lifetime_value ORDER BY lifetime_value DESC LIMIT 10;
SELECT * FROM app.daily_sales LIMIT 30;
SELECT c.name, COUNT(p.id) FROM app.categories c LEFT JOIN app.products p ON c.id = p.category_id GROUP BY c.id, c.name;
SELECT customer_tier, COUNT(*), SUM(total_amount) FROM app.order_summary GROUP BY customer_tier;
