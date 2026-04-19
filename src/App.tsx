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
import Dashboard from "./pages/Dashboard";
import Concentradores from "./pages/Concentradores";
import ConcentradorDetalhe from "./pages/ConcentradorDetalhe";
import RBS from "./pages/RBS";
import RbsDetalhe from "./pages/RbsDetalhe";
import PPPoE from "./pages/PPPoE";
import Alertas from "./pages/Alertas";
import Eventos from "./pages/Eventos";
import Metricas from "./pages/Metricas";
import Admin from "./pages/Admin";
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
              <Route path="/alertas" element={<Alertas />} />
              <Route path="/eventos" element={<Eventos />} />
              <Route path="/metricas" element={<Metricas />} />
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
