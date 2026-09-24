import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator, NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { TouchableOpacity, Text, View, StyleSheet } from 'react-native';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <View style={eb.container}>
          <Text style={eb.title}>Something went wrong</Text>
          <Text style={eb.msg}>{(this.state.error as Error).message}</Text>
          <TouchableOpacity style={eb.btn} onPress={() => this.setState({ error: null })}>
            <Text style={eb.btnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const eb = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: '#fff' },
  title: { fontSize: 18, fontWeight: '700', color: '#ef4444', marginBottom: 12 },
  msg: { fontSize: 13, color: '#475569', textAlign: 'center', marginBottom: 24 },
  btn: { backgroundColor: '#6366f1', borderRadius: 10, paddingHorizontal: 24, paddingVertical: 10 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});

import LoginScreen from './src/screens/LoginScreen';
import RegisterScreen from './src/screens/RegisterScreen';
import AdminScreen from './src/screens/AdminScreen';
import DataWorkspaceScreen from './src/screens/DataWorkspaceScreen';
import { ThemeProvider, useTheme } from './src/context/ThemeContext';
import { AuthProvider, useAuth } from './src/context/AuthContext';

export type RootStackParamList = {
  Login: undefined;
  Register: undefined;
  DataWorkspace: undefined;
  Admin: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function HeaderActions() {
  const { theme, toggle } = useTheme();
  const { user, logout } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const btn = [styles.headerBtn, { backgroundColor: theme.accentBg, borderColor: theme.accentBorder }];
  const label = [styles.headerBtnLabel, { color: theme.accent }];

  return (
    <View style={styles.headerRight}>
      {user?.role === 'admin' && (
        <TouchableOpacity style={btn} onPress={() => navigation.navigate('Admin')} activeOpacity={0.75}>
          <Text style={label}>Admin</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity style={btn} onPress={toggle} activeOpacity={0.75}>
        <Text style={styles.headerBtnIcon}>{theme.dark ? '☀️' : '🌙'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={btn} onPress={logout} activeOpacity={0.75}>
        <Text style={label}>Log out</Text>
      </TouchableOpacity>
    </View>
  );
}

function AppNavigator() {
  const { theme } = useTheme();
  const { token, user } = useAuth();

  if (!token) {
    return (
      <>
        <StatusBar style="dark" />
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Login" component={LoginScreen} />
          <Stack.Screen name="Register" component={RegisterScreen} />
        </Stack.Navigator>
      </>
    );
  }

  return (
    <>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <Stack.Navigator
        initialRouteName="DataWorkspace"
        screenOptions={{
          headerStyle: { backgroundColor: theme.headerBg },
          headerTitleStyle: { fontWeight: '700', color: theme.headerText },
          headerTintColor: theme.accent,
          contentStyle: { backgroundColor: theme.bg },
        }}
      >
        <Stack.Screen
          name="DataWorkspace"
          component={DataWorkspaceScreen}
          options={{ title: 'DataDesk', headerRight: () => <HeaderActions /> }}
        />
        {user?.role === 'admin' && (
          <Stack.Screen
            name="Admin"
            component={AdminScreen}
            options={{ title: 'Admin Panel' }}
          />
        )}
      </Stack.Navigator>
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ThemeProvider>
          <NavigationContainer>
            <AppNavigator />
          </NavigationContainer>
        </ThemeProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginRight: 4,
  },
  headerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  headerBtnIcon: { fontSize: 14 },
  headerBtnLabel: { fontSize: 12, fontWeight: '700' },
});
