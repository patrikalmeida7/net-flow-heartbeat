import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/hooks/useAuth";
import ProtectedRoute from "@/components/ProtectedRoute";
import AdminRoute from "@/components/AdminRoute";
import AppLayout from "@/components/AppLayout";
import Auth from "./pages/Auth";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import Concentradores from "./pages/Concentradores";
import ConcentradorDetalhe from "./pages/ConcentradorDetalhe";
import RBS from "./pages/RBS";
import RbsDetalhe from "./pages/RbsDetalhe";
import PPPoE from "./pages/PPPoE";
import ClienteDetalhe from "./pages/ClienteDetalhe";
import Alertas from "./pages/Alertas";
import Eventos from "./pages/Eventos";
import Metricas from "./pages/Metricas";
import DashboardsPersonalizadas from "./pages/DashboardsPersonalizadas";
import Analise from "./pages/Analise";
import Relatorios from "./pages/Relatorios";
import Admin from "./pages/Admin";
import TR069 from "./pages/TR069";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <Routes>
            <Route path="/auth" element={<Auth />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<Dashboard />} />
              <Route path="/concentradores" element={<Concentradores />} />
              <Route path="/concentradores/:id" element={<ConcentradorDetalhe />} />
              <Route path="/rbs" element={<RBS />} />
              <Route path="/rbs/:id" element={<RbsDetalhe />} />
              <Route path="/pppoe" element={<PPPoE />} />
              <Route path="/pppoe/:username" element={<ClienteDetalhe />} />
              <Route path="/pppoe/c/:concentradorId/:username" element={<ClienteDetalhe />} />
              <Route path="/alertas" element={<Alertas />} />
              <Route path="/eventos" element={<Eventos />} />
              <Route path="/metricas" element={<Metricas />} />
              <Route path="/dashboards" element={<DashboardsPersonalizadas />} />
              <Route path="/analise" element={<Analise />} />
              <Route path="/relatorios" element={<Relatorios />} />
              <Route path="/tr069" element={<TR069 />} />
              <Route
                path="/admin"
                element={
                  <AdminRoute>
                    <Admin />
                  </AdminRoute>
                }
              />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </TooltipProvider>
      </AuthProvider>
    </BrowserRouter>
  </QueryClientProvider>
);

export default App;
