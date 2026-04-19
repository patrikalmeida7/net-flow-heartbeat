export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agents: {
        Row: {
          created_at: string
          descricao: string | null
          enabled: boolean
          id: string
          last_ip: string | null
          last_seen_at: string | null
          nome: string
          token_hash: string
          updated_at: string
          version: string | null
        }
        Insert: {
          created_at?: string
          descricao?: string | null
          enabled?: boolean
          id?: string
          last_ip?: string | null
          last_seen_at?: string | null
          nome: string
          token_hash: string
          updated_at?: string
          version?: string | null
        }
        Update: {
          created_at?: string
          descricao?: string | null
          enabled?: boolean
          id?: string
          last_ip?: string | null
          last_seen_at?: string | null
          nome?: string
          token_hash?: string
          updated_at?: string
          version?: string | null
        }
        Relationships: []
      }
      alertas: {
        Row: {
          concentrador_id: string | null
          created_at: string
          descricao: string | null
          id: string
          rbs_id: string | null
          reconhecido_em: string | null
          reconhecido_por: string | null
          resolvido_em: string | null
          severidade: Database["public"]["Enums"]["alert_severity"]
          status: Database["public"]["Enums"]["alert_status"]
          titulo: string
        }
        Insert: {
          concentrador_id?: string | null
          created_at?: string
          descricao?: string | null
          id?: string
          rbs_id?: string | null
          reconhecido_em?: string | null
          reconhecido_por?: string | null
          resolvido_em?: string | null
          severidade?: Database["public"]["Enums"]["alert_severity"]
          status?: Database["public"]["Enums"]["alert_status"]
          titulo: string
        }
        Update: {
          concentrador_id?: string | null
          created_at?: string
          descricao?: string | null
          id?: string
          rbs_id?: string | null
          reconhecido_em?: string | null
          reconhecido_por?: string | null
          resolvido_em?: string | null
          severidade?: Database["public"]["Enums"]["alert_severity"]
          status?: Database["public"]["Enums"]["alert_status"]
          titulo?: string
        }
        Relationships: [
          {
            foreignKeyName: "alertas_concentrador_id_fkey"
            columns: ["concentrador_id"]
            isOneToOne: false
            referencedRelation: "concentradores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alertas_rbs_id_fkey"
            columns: ["rbs_id"]
            isOneToOne: false
            referencedRelation: "rbs"
            referencedColumns: ["id"]
          },
        ]
      }
      concentradores: {
        Row: {
          cpu_load: number | null
          created_at: string
          host: string
          host_interno: string | null
          id: string
          identidade: string | null
          memory_used_pct: number | null
          modelo: string | null
          nome: string
          observacoes: string | null
          status: Database["public"]["Enums"]["device_status"]
          ultima_coleta: string | null
          updated_at: string
          uptime_seconds: number | null
          usuarios_online: number
          versao_routeros: string | null
          vpn_connection_id: string | null
        }
        Insert: {
          cpu_load?: number | null
          created_at?: string
          host: string
          host_interno?: string | null
          id?: string
          identidade?: string | null
          memory_used_pct?: number | null
          modelo?: string | null
          nome: string
          observacoes?: string | null
          status?: Database["public"]["Enums"]["device_status"]
          ultima_coleta?: string | null
          updated_at?: string
          uptime_seconds?: number | null
          usuarios_online?: number
          versao_routeros?: string | null
          vpn_connection_id?: string | null
        }
        Update: {
          cpu_load?: number | null
          created_at?: string
          host?: string
          host_interno?: string | null
          id?: string
          identidade?: string | null
          memory_used_pct?: number | null
          modelo?: string | null
          nome?: string
          observacoes?: string | null
          status?: Database["public"]["Enums"]["device_status"]
          ultima_coleta?: string | null
          updated_at?: string
          uptime_seconds?: number | null
          usuarios_online?: number
          versao_routeros?: string | null
          vpn_connection_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "concentradores_vpn_connection_id_fkey"
            columns: ["vpn_connection_id"]
            isOneToOne: false
            referencedRelation: "vpn_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      device_credentials: {
        Row: {
          concentrador_id: string | null
          created_at: string
          enabled: boolean
          host: string
          id: string
          last_error: string | null
          last_poll_at: string | null
          observacoes: string | null
          password_encrypted: string
          password_nonce: string
          port: number
          protocol: Database["public"]["Enums"]["remote_protocol"]
          rbs_id: string | null
          updated_at: string
          username: string
        }
        Insert: {
          concentrador_id?: string | null
          created_at?: string
          enabled?: boolean
          host: string
          id?: string
          last_error?: string | null
          last_poll_at?: string | null
          observacoes?: string | null
          password_encrypted: string
          password_nonce: string
          port?: number
          protocol?: Database["public"]["Enums"]["remote_protocol"]
          rbs_id?: string | null
          updated_at?: string
          username: string
        }
        Update: {
          concentrador_id?: string | null
          created_at?: string
          enabled?: boolean
          host?: string
          id?: string
          last_error?: string | null
          last_poll_at?: string | null
          observacoes?: string | null
          password_encrypted?: string
          password_nonce?: string
          port?: number
          protocol?: Database["public"]["Enums"]["remote_protocol"]
          rbs_id?: string | null
          updated_at?: string
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_credentials_concentrador_id_fkey"
            columns: ["concentrador_id"]
            isOneToOne: false
            referencedRelation: "concentradores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_credentials_rbs_id_fkey"
            columns: ["rbs_id"]
            isOneToOne: false
            referencedRelation: "rbs"
            referencedColumns: ["id"]
          },
        ]
      }
      device_interfaces: {
        Row: {
          admin_status: string | null
          concentrador_id: string | null
          created_at: string
          id: string
          if_alias: string | null
          if_descr: string | null
          if_index: number
          if_name: string | null
          if_speed_bps: number | null
          last_in_octets: number | null
          last_out_octets: number | null
          last_sample_at: string | null
          oper_status: string | null
          rbs_id: string | null
          updated_at: string
        }
        Insert: {
          admin_status?: string | null
          concentrador_id?: string | null
          created_at?: string
          id?: string
          if_alias?: string | null
          if_descr?: string | null
          if_index: number
          if_name?: string | null
          if_speed_bps?: number | null
          last_in_octets?: number | null
          last_out_octets?: number | null
          last_sample_at?: string | null
          oper_status?: string | null
          rbs_id?: string | null
          updated_at?: string
        }
        Update: {
          admin_status?: string | null
          concentrador_id?: string | null
          created_at?: string
          id?: string
          if_alias?: string | null
          if_descr?: string | null
          if_index?: number
          if_name?: string | null
          if_speed_bps?: number | null
          last_in_octets?: number | null
          last_out_octets?: number | null
          last_sample_at?: string | null
          oper_status?: string | null
          rbs_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_interfaces_concentrador_id_fkey"
            columns: ["concentrador_id"]
            isOneToOne: false
            referencedRelation: "concentradores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_interfaces_rbs_id_fkey"
            columns: ["rbs_id"]
            isOneToOne: false
            referencedRelation: "rbs"
            referencedColumns: ["id"]
          },
        ]
      }
      device_ssh_polls: {
        Row: {
          collected_at: string
          concentrador_id: string | null
          credential_id: string
          duration_ms: number | null
          error: string | null
          id: string
          rbs_id: string | null
          results: Json
          success: boolean
        }
        Insert: {
          collected_at?: string
          concentrador_id?: string | null
          credential_id: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          rbs_id?: string | null
          results?: Json
          success: boolean
        }
        Update: {
          collected_at?: string
          concentrador_id?: string | null
          credential_id?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          rbs_id?: string | null
          results?: Json
          success?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "device_ssh_polls_concentrador_id_fkey"
            columns: ["concentrador_id"]
            isOneToOne: false
            referencedRelation: "concentradores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_ssh_polls_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "device_credentials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_ssh_polls_rbs_id_fkey"
            columns: ["rbs_id"]
            isOneToOne: false
            referencedRelation: "rbs"
            referencedColumns: ["id"]
          },
        ]
      }
      eventos: {
        Row: {
          concentrador_id: string | null
          created_at: string
          descricao: string | null
          id: string
          metadata: Json | null
          rbs_id: string | null
          tipo: Database["public"]["Enums"]["event_type"]
          username: string | null
        }
        Insert: {
          concentrador_id?: string | null
          created_at?: string
          descricao?: string | null
          id?: string
          metadata?: Json | null
          rbs_id?: string | null
          tipo: Database["public"]["Enums"]["event_type"]
          username?: string | null
        }
        Update: {
          concentrador_id?: string | null
          created_at?: string
          descricao?: string | null
          id?: string
          metadata?: Json | null
          rbs_id?: string | null
          tipo?: Database["public"]["Enums"]["event_type"]
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "eventos_concentrador_id_fkey"
            columns: ["concentrador_id"]
            isOneToOne: false
            referencedRelation: "concentradores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eventos_rbs_id_fkey"
            columns: ["rbs_id"]
            isOneToOne: false
            referencedRelation: "rbs"
            referencedColumns: ["id"]
          },
        ]
      }
      metric_samples: {
        Row: {
          collected_at: string
          concentrador_id: string | null
          id: number
          interface_id: string | null
          kind: Database["public"]["Enums"]["metric_kind"]
          rbs_id: string | null
          value: number
        }
        Insert: {
          collected_at?: string
          concentrador_id?: string | null
          id?: number
          interface_id?: string | null
          kind: Database["public"]["Enums"]["metric_kind"]
          rbs_id?: string | null
          value: number
        }
        Update: {
          collected_at?: string
          concentrador_id?: string | null
          id?: number
          interface_id?: string | null
          kind?: Database["public"]["Enums"]["metric_kind"]
          rbs_id?: string | null
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "metric_samples_concentrador_id_fkey"
            columns: ["concentrador_id"]
            isOneToOne: false
            referencedRelation: "concentradores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metric_samples_interface_id_fkey"
            columns: ["interface_id"]
            isOneToOne: false
            referencedRelation: "device_interfaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metric_samples_rbs_id_fkey"
            columns: ["rbs_id"]
            isOneToOne: false
            referencedRelation: "rbs"
            referencedColumns: ["id"]
          },
        ]
      }
      pppoe_sessions: {
        Row: {
          bytes_in: number | null
          bytes_out: number | null
          caller_id: string | null
          concentrador_id: string | null
          conectado_em: string
          desconectado_em: string | null
          id: string
          interface: string | null
          ip_address: string | null
          online: boolean
          ultima_atualizacao: string
          uptime_seconds: number | null
          username: string
        }
        Insert: {
          bytes_in?: number | null
          bytes_out?: number | null
          caller_id?: string | null
          concentrador_id?: string | null
          conectado_em?: string
          desconectado_em?: string | null
          id?: string
          interface?: string | null
          ip_address?: string | null
          online?: boolean
          ultima_atualizacao?: string
          uptime_seconds?: number | null
          username: string
        }
        Update: {
          bytes_in?: number | null
          bytes_out?: number | null
          caller_id?: string | null
          concentrador_id?: string | null
          conectado_em?: string
          desconectado_em?: string | null
          id?: string
          interface?: string | null
          ip_address?: string | null
          online?: boolean
          ultima_atualizacao?: string
          uptime_seconds?: number | null
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "pppoe_sessions_concentrador_id_fkey"
            columns: ["concentrador_id"]
            isOneToOne: false
            referencedRelation: "concentradores"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      rbs: {
        Row: {
          created_at: string
          endereco: string | null
          host: string | null
          host_interno: string | null
          id: string
          latitude: number | null
          longitude: number | null
          nome: string
          observacoes: string | null
          perda_pct: number | null
          ping_ms: number | null
          status: Database["public"]["Enums"]["device_status"]
          ultima_coleta: string | null
          updated_at: string
          uso_banda_mbps: number | null
          vpn_connection_id: string | null
        }
        Insert: {
          created_at?: string
          endereco?: string | null
          host?: string | null
          host_interno?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          nome: string
          observacoes?: string | null
          perda_pct?: number | null
          ping_ms?: number | null
          status?: Database["public"]["Enums"]["device_status"]
          ultima_coleta?: string | null
          updated_at?: string
          uso_banda_mbps?: number | null
          vpn_connection_id?: string | null
        }
        Update: {
          created_at?: string
          endereco?: string | null
          host?: string | null
          host_interno?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          nome?: string
          observacoes?: string | null
          perda_pct?: number | null
          ping_ms?: number | null
          status?: Database["public"]["Enums"]["device_status"]
          ultima_coleta?: string | null
          updated_at?: string
          uso_banda_mbps?: number | null
          vpn_connection_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rbs_vpn_connection_id_fkey"
            columns: ["vpn_connection_id"]
            isOneToOne: false
            referencedRelation: "vpn_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      snmp_credentials: {
        Row: {
          auth_password: string | null
          auth_proto: Database["public"]["Enums"]["snmp_auth_proto"]
          community: string | null
          concentrador_id: string | null
          created_at: string
          enabled: boolean
          id: string
          last_error: string | null
          last_poll_at: string | null
          poll_interval_seconds: number
          port: number
          priv_password: string | null
          priv_proto: Database["public"]["Enums"]["snmp_priv_proto"]
          rbs_id: string | null
          retries: number
          timeout_ms: number
          updated_at: string
          username: string | null
          version: Database["public"]["Enums"]["snmp_version"]
        }
        Insert: {
          auth_password?: string | null
          auth_proto?: Database["public"]["Enums"]["snmp_auth_proto"]
          community?: string | null
          concentrador_id?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          last_error?: string | null
          last_poll_at?: string | null
          poll_interval_seconds?: number
          port?: number
          priv_password?: string | null
          priv_proto?: Database["public"]["Enums"]["snmp_priv_proto"]
          rbs_id?: string | null
          retries?: number
          timeout_ms?: number
          updated_at?: string
          username?: string | null
          version?: Database["public"]["Enums"]["snmp_version"]
        }
        Update: {
          auth_password?: string | null
          auth_proto?: Database["public"]["Enums"]["snmp_auth_proto"]
          community?: string | null
          concentrador_id?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          last_error?: string | null
          last_poll_at?: string | null
          poll_interval_seconds?: number
          port?: number
          priv_password?: string | null
          priv_proto?: Database["public"]["Enums"]["snmp_priv_proto"]
          rbs_id?: string | null
          retries?: number
          timeout_ms?: number
          updated_at?: string
          username?: string | null
          version?: Database["public"]["Enums"]["snmp_version"]
        }
        Relationships: [
          {
            foreignKeyName: "snmp_credentials_concentrador_id_fkey"
            columns: ["concentrador_id"]
            isOneToOne: false
            referencedRelation: "concentradores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snmp_credentials_rbs_id_fkey"
            columns: ["rbs_id"]
            isOneToOne: false
            referencedRelation: "rbs"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      vpn_connections: {
        Row: {
          agent_id: string | null
          created_at: string
          desired_state: Database["public"]["Enums"]["vpn_desired_state"]
          enabled: boolean
          endpoint_host: string
          endpoint_port: number
          grupo: string | null
          id: string
          nome: string
          observacoes: string | null
          ovpn_config_encrypted: string | null
          ovpn_config_nonce: string | null
          ovpn_password_encrypted: string | null
          ovpn_password_nonce: string | null
          ovpn_username: string | null
          protocol: Database["public"]["Enums"]["vpn_protocol"]
          updated_at: string
          wg_address_cidr: string | null
          wg_allowed_ips: string | null
          wg_dns: string | null
          wg_peer_public_key: string | null
          wg_persistent_keepalive: number | null
          wg_preshared_key_encrypted: string | null
          wg_preshared_key_nonce: string | null
          wg_private_key_encrypted: string | null
          wg_private_key_nonce: string | null
        }
        Insert: {
          agent_id?: string | null
          created_at?: string
          desired_state?: Database["public"]["Enums"]["vpn_desired_state"]
          enabled?: boolean
          endpoint_host: string
          endpoint_port: number
          grupo?: string | null
          id?: string
          nome: string
          observacoes?: string | null
          ovpn_config_encrypted?: string | null
          ovpn_config_nonce?: string | null
          ovpn_password_encrypted?: string | null
          ovpn_password_nonce?: string | null
          ovpn_username?: string | null
          protocol: Database["public"]["Enums"]["vpn_protocol"]
          updated_at?: string
          wg_address_cidr?: string | null
          wg_allowed_ips?: string | null
          wg_dns?: string | null
          wg_peer_public_key?: string | null
          wg_persistent_keepalive?: number | null
          wg_preshared_key_encrypted?: string | null
          wg_preshared_key_nonce?: string | null
          wg_private_key_encrypted?: string | null
          wg_private_key_nonce?: string | null
        }
        Update: {
          agent_id?: string | null
          created_at?: string
          desired_state?: Database["public"]["Enums"]["vpn_desired_state"]
          enabled?: boolean
          endpoint_host?: string
          endpoint_port?: number
          grupo?: string | null
          id?: string
          nome?: string
          observacoes?: string | null
          ovpn_config_encrypted?: string | null
          ovpn_config_nonce?: string | null
          ovpn_password_encrypted?: string | null
          ovpn_password_nonce?: string | null
          ovpn_username?: string | null
          protocol?: Database["public"]["Enums"]["vpn_protocol"]
          updated_at?: string
          wg_address_cidr?: string | null
          wg_allowed_ips?: string | null
          wg_dns?: string | null
          wg_peer_public_key?: string | null
          wg_persistent_keepalive?: number | null
          wg_preshared_key_encrypted?: string | null
          wg_preshared_key_nonce?: string | null
          wg_private_key_encrypted?: string | null
          wg_private_key_nonce?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vpn_connections_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      vpn_events: {
        Row: {
          created_at: string
          event_type: string
          id: number
          message: string | null
          metadata: Json | null
          vpn_connection_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: number
          message?: string | null
          metadata?: Json | null
          vpn_connection_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: number
          message?: string | null
          metadata?: Json | null
          vpn_connection_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vpn_events_vpn_connection_id_fkey"
            columns: ["vpn_connection_id"]
            isOneToOne: false
            referencedRelation: "vpn_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      vpn_status: {
        Row: {
          internal_ip: string | null
          last_error: string | null
          last_handshake_at: string | null
          latency_ms: number | null
          online: boolean
          reported_at: string
          rx_bytes: number | null
          tx_bytes: number | null
          uptime_seconds: number | null
          vpn_connection_id: string
        }
        Insert: {
          internal_ip?: string | null
          last_error?: string | null
          last_handshake_at?: string | null
          latency_ms?: number | null
          online?: boolean
          reported_at?: string
          rx_bytes?: number | null
          tx_bytes?: number | null
          uptime_seconds?: number | null
          vpn_connection_id: string
        }
        Update: {
          internal_ip?: string | null
          last_error?: string | null
          last_handshake_at?: string | null
          latency_ms?: number | null
          online?: boolean
          reported_at?: string
          rx_bytes?: number | null
          tx_bytes?: number | null
          uptime_seconds?: number | null
          vpn_connection_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vpn_status_vpn_connection_id_fkey"
            columns: ["vpn_connection_id"]
            isOneToOne: true
            referencedRelation: "vpn_connections"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_device_credential_password: {
        Args: { _credential_id: string }
        Returns: string
      }
      get_vpn_secret: {
        Args: { _connection_id: string; _field: string }
        Returns: string
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      purge_old_metric_samples: { Args: never; Returns: undefined }
      set_device_credential_password: {
        Args: { _credential_id: string; _password: string }
        Returns: undefined
      }
      set_vpn_secret: {
        Args: { _connection_id: string; _field: string; _value: string }
        Returns: undefined
      }
    }
    Enums: {
      alert_severity: "info" | "warning" | "critical"
      alert_status: "active" | "acknowledged" | "resolved"
      app_role: "admin" | "tecnico" | "visualizador"
      device_status: "online" | "warning" | "offline" | "unknown"
      event_type:
        | "connect"
        | "disconnect"
        | "device_down"
        | "device_up"
        | "rbs_down"
        | "rbs_up"
        | "flapping"
      metric_kind:
        | "cpu_load"
        | "memory_used_pct"
        | "uptime_seconds"
        | "temperature_c"
        | "if_in_bps"
        | "if_out_bps"
        | "if_in_errors"
        | "if_out_errors"
        | "if_oper_status"
        | "ping_ms"
        | "ping_loss_pct"
      remote_protocol: "ssh" | "telnet"
      snmp_auth_proto: "none" | "MD5" | "SHA"
      snmp_priv_proto: "none" | "DES" | "AES"
      snmp_version: "v2c" | "v3"
      vpn_desired_state: "up" | "down"
      vpn_protocol: "wireguard" | "openvpn"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      alert_severity: ["info", "warning", "critical"],
      alert_status: ["active", "acknowledged", "resolved"],
      app_role: ["admin", "tecnico", "visualizador"],
      device_status: ["online", "warning", "offline", "unknown"],
      event_type: [
        "connect",
        "disconnect",
        "device_down",
        "device_up",
        "rbs_down",
        "rbs_up",
        "flapping",
      ],
      metric_kind: [
        "cpu_load",
        "memory_used_pct",
        "uptime_seconds",
        "temperature_c",
        "if_in_bps",
        "if_out_bps",
        "if_in_errors",
        "if_out_errors",
        "if_oper_status",
        "ping_ms",
        "ping_loss_pct",
      ],
      remote_protocol: ["ssh", "telnet"],
      snmp_auth_proto: ["none", "MD5", "SHA"],
      snmp_priv_proto: ["none", "DES", "AES"],
      snmp_version: ["v2c", "v3"],
      vpn_desired_state: ["up", "down"],
      vpn_protocol: ["wireguard", "openvpn"],
    },
  },
} as const
