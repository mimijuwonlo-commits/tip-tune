import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ArtistProfilePage from '../ArtistProfilePage';

vi.mock('@/services/artistService', async () => {
  const actual = await vi.importActual<any>('@/services/artistService');
  return {
    ...actual,
    fetchArtistProfilePage: vi.fn().mockResolvedValue({
      artist: {
        id: 'dj-melodica',
        artistName: 'DJ Melodica',
        bio: 'Test bio',
        profileImage: 'https://example.com/avatar.jpg',
        coverImage: 'https://example.com/cover.jpg',
        accentColor: '#ff0000',
        totalTipsReceived: 1234.56,
        followerCount: 42,
        isFollowing: false,
        socialLinks: {
          twitter: 'https://x.com/test',
        },
      },
      tracks: [
        {
          id: 't1',
          title: 'Track One',
          coverArt: 'https://example.com/track.jpg',
          plays: 100,
          tips: 10,
          artist: { id: 'dj-melodica', artistName: 'DJ Melodica' },
          filename: 'https://example.com/audio.mp3',
        },
      ],
      recentTips: [
        {
          id: 'tip1',
          tipperName: 'Alice',
          tipperAvatar: 'https://example.com/alice.jpg',
          amount: 5,
          message: 'Great!',
          timestamp: new Date().toISOString(),
          trackId: 't1',
        },
      ],
    }),
  };
});

// Mock play/pause to avoid jsdom media errors
beforeEach(() => {
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: vi.fn(),
  });
});

function renderWithRoute(path = '/artists/dj-melodica') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/artists/:artistId" element={<ArtistProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ArtistProfilePage', () => {
  it('shows loading state then renders profile sections', async () => {
    renderWithRoute();

    // Loading skeletons present initially
    expect(screen.getAllByRole('generic').length).toBeGreaterThan(0);

    // Wait for artist name to appear
    expect(await screen.findByText('DJ Melodica')).toBeInTheDocument();

    // Core sections
    expect(screen.getByText('Stats')).toBeInTheDocument();
    expect(screen.getAllByText('Tracks').length).toBeGreaterThan(0);
    expect(screen.getByText('About')).toBeInTheDocument();
    expect(screen.getByText('Recent Tips')).toBeInTheDocument();

    // Basic stats rendered
    expect(screen.getAllByText(/Followers/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Total Tips/i)).toBeInTheDocument();
  });

  it('can follow and share', async () => {
    // Mock clipboard support
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderWithRoute();
    const followBtn = await screen.findByRole('button', { name: /follow/i });
    fireEvent.click(followBtn);

    // Button transitions to Updating... then to Unfollow after state settles
    await waitFor(() => {
      // "Updating..." may be very brief; check that button exists with either label
      const maybeUnfollow = screen.getByRole('button', { name: /unfollow|updating/i });
      expect(maybeUnfollow).toBeInTheDocument();
    });

    const shareBtn = screen.getByRole('button', { name: /share profile/i });
    fireEvent.click(shareBtn);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
  });

  it('can play a track inline', async () => {
    renderWithRoute();
    const playBtn = await screen.findByRole('button', { name: /play track one/i });
    fireEvent.click(playBtn);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /pause track one/i })).toBeInTheDocument();
    });
  });
});

