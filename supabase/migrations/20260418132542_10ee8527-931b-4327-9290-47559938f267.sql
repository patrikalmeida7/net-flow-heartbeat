
-- ===== ENUMS =====
CREATE TYPE public.app_role AS ENUM ('admin', 'tecnico', 'visualizador');
CREATE TYPE public.device_status AS ENUM ('online', 'warning', 'offline', 'unknown');
CREATE TYPE public.alert_severity AS ENUM ('info', 'warning', 'critical');
CREATE TYPE public.alert_status AS ENUM ('active', 'acknowledged', 'resolved');
CREATE TYPE public.event_type AS ENUM ('connect', 'disconnect', 'device_down', 'device_up', 'rbs_down', 'rbs_up', 'flapping');

-- ===== PROFILES =====
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ===== USER ROLES (separate table — security best practice) =====
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Security definer function to check role (avoids RLS recursion)
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- ===== CONCENTRADORES (MikroTik) =====
CREATE TABLE public.concentradores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  host TEXT NOT NULL,
  identidade TEXT,
  modelo TEXT,
  versao_routeros TEXT,
  status device_status NOT NULL DEFAULT 'unknown',
  cpu_load INTEGER,
  memory_used_pct INTEGER,
  uptime_seconds BIGINT,
  usuarios_online INTEGER NOT NULL DEFAULT 0,
  ultima_coleta TIMESTAMPTZ,
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.concentradores ENABLE ROW LEVEL SECURITY;

-- ===== RBS / TORRES =====
CREATE TABLE public.rbs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  host TEXT,
  endereco TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  status device_status NOT NULL DEFAULT 'unknown',
  ping_ms INTEGER,
  perda_pct INTEGER,
  uso_banda_mbps NUMERIC(10,2),
  ultima_coleta TIMESTAMPTZ,
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.rbs ENABLE ROW LEVEL SECURITY;

-- ===== SESSÕES PPPOE =====
CREATE TABLE public.pppoe_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  concentrador_id UUID REFERENCES public.concentradores(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  ip_address TEXT,
  caller_id TEXT,
  interface TEXT,
  uptime_seconds BIGINT,
  bytes_in BIGINT DEFAULT 0,
  bytes_out BIGINT DEFAULT 0,
  online BOOLEAN NOT NULL DEFAULT true,
  conectado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  desconectado_em TIMESTAMPTZ,
  ultima_atualizacao TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.pppoe_sessions ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_pppoe_username ON public.pppoe_sessions(username);
CREATE INDEX idx_pppoe_online ON public.pppoe_sessions(online);
CREATE INDEX idx_pppoe_concentrador ON public.pppoe_sessions(concentrador_id);

-- ===== EVENTOS =====
CREATE TABLE public.eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo event_type NOT NULL,
  concentrador_id UUID REFERENCES public.concentradores(id) ON DELETE SET NULL,
  rbs_id UUID REFERENCES public.rbs(id) ON DELETE SET NULL,
  username TEXT,
  descricao TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.eventos ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_eventos_created ON public.eventos(created_at DESC);
CREATE INDEX idx_eventos_tipo ON public.eventos(tipo);

-- ===== ALERTAS =====
CREATE TABLE public.alertas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo TEXT NOT NULL,
  descricao TEXT,
  severidade alert_severity NOT NULL DEFAULT 'warning',
  status alert_status NOT NULL DEFAULT 'active',
  concentrador_id UUID REFERENCES public.concentradores(id) ON DELETE SET NULL,
  rbs_id UUID REFERENCES public.rbs(id) ON DELETE SET NULL,
  reconhecido_por UUID REFERENCES auth.users(id),
  reconhecido_em TIMESTAMPTZ,
  resolvido_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.alertas ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_alertas_status ON public.alertas(status);
CREATE INDEX idx_alertas_created ON public.alertas(created_at DESC);

-- ===== TRIGGERS: updated_at =====
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_concentradores_updated BEFORE UPDATE ON public.concentradores
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_rbs_updated BEFORE UPDATE ON public.rbs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===== TRIGGER: auto-create profile on signup =====
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email)
  );
  -- First user becomes admin, others get visualizador
  IF (SELECT COUNT(*) FROM public.user_roles) = 0 THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'visualizador');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ===== RLS POLICIES =====

-- profiles: own
CREATE POLICY "users_view_own_profile" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "users_update_own_profile" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "admins_view_all_profiles" ON public.profiles
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- user_roles
CREATE POLICY "users_view_own_roles" ON public.user_roles
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "admins_view_all_roles" ON public.user_roles
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "admins_manage_roles" ON public.user_roles
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- concentradores: all auth view; admin manage
CREATE POLICY "auth_view_concentradores" ON public.concentradores
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins_manage_concentradores" ON public.concentradores
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- rbs
CREATE POLICY "auth_view_rbs" ON public.rbs
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins_manage_rbs" ON public.rbs
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- pppoe_sessions: all auth view (read-only from UI; writes via service role)
CREATE POLICY "auth_view_pppoe" ON public.pppoe_sessions
  FOR SELECT TO authenticated USING (true);

-- eventos
CREATE POLICY "auth_view_eventos" ON public.eventos
  FOR SELECT TO authenticated USING (true);

-- alertas: all view; admin/tecnico can update (acknowledge/resolve)
CREATE POLICY "auth_view_alertas" ON public.alertas
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "tecnicos_update_alertas" ON public.alertas
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'tecnico'));
CREATE POLICY "admins_delete_alertas" ON public.alertas
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ===== REALTIME =====
ALTER PUBLICATION supabase_realtime ADD TABLE public.concentradores;
ALTER PUBLICATION supabase_realtime ADD TABLE public.rbs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.pppoe_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.eventos;
ALTER PUBLICATION supabase_realtime ADD TABLE public.alertas;

ALTER TABLE public.concentradores REPLICA IDENTITY FULL;
ALTER TABLE public.rbs REPLICA IDENTITY FULL;
ALTER TABLE public.pppoe_sessions REPLICA IDENTITY FULL;
ALTER TABLE public.alertas REPLICA IDENTITY FULL;

-- ===== SEED DATA (mock realista para Fase 1) =====
INSERT INTO public.concentradores (nome, host, identidade, modelo, versao_routeros, status, cpu_load, memory_used_pct, uptime_seconds, usuarios_online, ultima_coleta) VALUES
('CONC-CENTRO-01', '10.0.0.1', 'mk-centro-01', 'CCR2004-1G-12S+2XS', '7.13.5', 'online', 22, 41, 1843200, 487, now()),
('CONC-NORTE-01', '10.0.0.2', 'mk-norte-01', 'CCR2116-12G-4S+', '7.14.1', 'online', 35, 58, 982400, 612, now()),
('CONC-SUL-01', '10.0.0.3', 'mk-sul-01', 'CCR1036-12G-4S', '7.13.5', 'warning', 78, 82, 432100, 354, now()),
('CONC-LESTE-01', '10.0.0.4', 'mk-leste-01', 'CCR2004-1G-12S+2XS', '7.13.5', 'offline', 0, 0, 0, 0, now() - interval '12 minutes'),
('CONC-OESTE-01', '10.0.0.5', 'mk-oeste-01', 'CCR1036-12G-4S', '7.12.2', 'online', 18, 39, 2592000, 298, now());

INSERT INTO public.rbs (nome, host, endereco, latitude, longitude, status, ping_ms, perda_pct, uso_banda_mbps, ultima_coleta) VALUES
('RBS-CENTRO', '10.10.1.1', 'Av. Brasil, 1200', -23.5505, -46.6333, 'online', 4, 0, 487.3, now()),
('RBS-VILA NOVA', '10.10.1.2', 'Rua das Flores, 45', -23.5611, -46.6411, 'online', 7, 0, 312.8, now()),
('RBS-MORRO ALTO', '10.10.1.3', 'Estrada do Morro, km 4', -23.5712, -46.6522, 'warning', 38, 5, 198.4, now()),
('RBS-INDUSTRIAL', '10.10.1.4', 'Distrito Industrial', -23.5402, -46.6201, 'online', 6, 0, 412.1, now()),
('RBS-LITORAL', '10.10.1.5', 'Av. Beira Mar, 800', -23.5901, -46.6099, 'offline', NULL, 100, 0, now() - interval '8 minutes'),
('RBS-PLANALTO', '10.10.1.6', 'Alto da Serra', -23.5301, -46.6499, 'online', 12, 1, 256.7, now());

INSERT INTO public.alertas (titulo, descricao, severidade, status, concentrador_id) 
SELECT 'Concentrador offline', 'CONC-LESTE-01 não responde há 12 minutos', 'critical', 'active', id 
FROM public.concentradores WHERE nome='CONC-LESTE-01';

INSERT INTO public.alertas (titulo, descricao, severidade, status, concentrador_id) 
SELECT 'CPU alto', 'CONC-SUL-01 com CPU em 78%', 'warning', 'active', id 
FROM public.concentradores WHERE nome='CONC-SUL-01';

INSERT INTO public.alertas (titulo, descricao, severidade, status, rbs_id) 
SELECT 'RBS offline', 'RBS-LITORAL sem resposta', 'critical', 'active', id 
FROM public.rbs WHERE nome='RBS-LITORAL';

INSERT INTO public.alertas (titulo, descricao, severidade, status, rbs_id) 
SELECT 'Latência alta', 'RBS-MORRO ALTO com 38ms e 5% de perda', 'warning', 'active', id 
FROM public.rbs WHERE nome='RBS-MORRO ALTO';

-- Sessões PPPoE mock
INSERT INTO public.pppoe_sessions (concentrador_id, username, ip_address, caller_id, interface, uptime_seconds, bytes_in, bytes_out, online, conectado_em)
SELECT 
  c.id,
  'cliente_' || lpad(g::text, 5, '0'),
  '10.20.' || (g/254)::int || '.' || ((g % 254) + 1)::text,
  '0' || (1000000000 + g)::text,
  '<pppoe-' || g || '>',
  (random() * 86400)::bigint,
  (random() * 5000000000)::bigint,
  (random() * 1000000000)::bigint,
  true,
  now() - (random() * interval '24 hours')
FROM public.concentradores c, generate_series(1, 30) g
WHERE c.status = 'online';

-- Eventos recentes
INSERT INTO public.eventos (tipo, concentrador_id, descricao, created_at)
SELECT 'device_down', id, 'Concentrador deixou de responder', now() - interval '12 minutes'
FROM public.concentradores WHERE nome='CONC-LESTE-01';

INSERT INTO public.eventos (tipo, rbs_id, descricao, created_at)
SELECT 'rbs_down', id, 'RBS sem resposta de ping', now() - interval '8 minutes'
FROM public.rbs WHERE nome='RBS-LITORAL';

INSERT INTO public.eventos (tipo, username, descricao, created_at)
SELECT 'disconnect', 'cliente_00042', 'Sessão encerrada (timeout)', now() - interval '3 minutes';

INSERT INTO public.eventos (tipo, username, descricao, created_at)
SELECT 'connect', 'cliente_00091', 'Sessão iniciada', now() - interval '2 minutes';

INSERT INTO public.eventos (tipo, username, descricao, created_at)
SELECT 'flapping', 'cliente_00133', 'Usuário caiu 6 vezes em 10 minutos', now() - interval '1 minute';
