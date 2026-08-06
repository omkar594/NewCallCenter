import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

// `roles`: optional array - when given, a logged-in user whose role isn't in the list gets
// bounced to their own role's home instead of seeing a page meant for someone else.
export default function ProtectedRoute({ roles }) {
  const { user } = useAuth();

  if (!user) return <Navigate to="/login" replace />;

  if (roles && !roles.includes(user.role)) {
    return <Navigate to={homeForRole(user.role)} replace />;
  }

  return <Outlet />;
}

export function homeForRole(role) {
  if (role === 'super_admin') return '/admin';
  if (role === 'agent') return '/softphone';
  return '/app';
}
